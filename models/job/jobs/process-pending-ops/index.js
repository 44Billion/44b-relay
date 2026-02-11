import { Buffer } from 'buffer'
import { ConservativeCountMin } from 'sketch-oxide-node'
import mdb from '#services/db/mdb.js'
import { pruneEvents } from '#services/event/maintainer/mdb/index.js'
import { HyperLogLog as HLL } from 'nostr-hll/hyperloglog.js'
import { base64ToBytes, bytesToBase64 } from '#helpers/base64.js'
import { createSketch } from '#services/event/tracker/mdb/ip-activity.js'
import { wait } from '#helpers/timer.js'
import { compressAsync, decompressAsync } from '#helpers/buffer.js'

const BATCH_SIZE = 100
const MAX_FILL_ATTEMPTS = 2
const FILL_WAIT_MS = 1500
const SYSTEM_STATE_KEY = '__processingState__'

// Define known index behaviors (pkField)
const INDEX_CONFIG = {
  events: { pkField: 'ref' },
  storedEventOwners: { pkField: 'key' },
  ipActivities: { pkField: 'key' },
  requestedPubkeys: { pkField: 'key' },
  pendingOps: { pkField: 'key' } // Should not be target of ops usually
}

const KNOWN_INDEXES = Object.keys(INDEX_CONFIG)

const getPkField = (index) => {
  if (!INDEX_CONFIG[index]?.pkField) throw new Error(`Missing "pkField" config for index: ${index}`)
  return INDEX_CONFIG[index].pkField
}

export async function loadSystemState () {
  const state = {}
  await Promise.all(KNOWN_INDEXES.map(async (indexName) => {
    try {
      const doc = await mdb.index(indexName).getDocument(SYSTEM_STATE_KEY)
      state[indexName] = new Set(doc.processedOpIds || [])
    } catch (_) {
      state[indexName] = new Set()
    }
  }))
  return state
}

const log = process.env.NODE_ENV === 'production' ? console.log : () => {}
export async function run () {
  log('Processing pending storage operations...')

  const systemState = await loadSystemState()

  let opsBuffer = []
  let fillAttempts = 0

  while (true) {
    const needed = BATCH_SIZE - opsBuffer.length

    if (needed > 0) {
      try {
        const { hits } = await mdb.index('pendingOps').search('', {
          limit: needed,
          offset: opsBuffer.length,
          sort: ['createdAt:asc']
        })
        if (hits.length > 0) {
          opsBuffer = opsBuffer.concat(hits)
        }
      } catch (err) {
        console.error('Error fetching pending ops', err)
        await wait(FILL_WAIT_MS)
        continue
      }
    }

    const isFull = opsBuffer.length >= BATCH_SIZE
    const isEmpty = opsBuffer.length === 0
    // "more than 0 operations, but less than the BATCH_SIZE"
    const isPartial = !isFull && !isEmpty

    if (isEmpty) {
      fillAttempts = 0
      await wait(FILL_WAIT_MS)
      continue
    }

    if (isPartial) {
      if (fillAttempts < MAX_FILL_ATTEMPTS) {
        fillAttempts++
        await wait(FILL_WAIT_MS)
        continue // Loop back to fetch remainder
      }
      // Else: Max attempts reached, proceed to process
    }

    // --- Processing Block ---
    // Extract buffer for processing and reset state for next batch immediately
    const results = [...opsBuffer]
    opsBuffer = []
    fillAttempts = 0

    await processBatch(results, systemState)
  }
  // log('Done processing pending storage operations.')
}

export async function processBatch (results, systemState) {
  // Accumulators
  const docsToAddOrUpdate = {} // index -> Map<key, doc>
  const keysToDelete = {} // index -> Set<primaryKey>
  const processedOpsInBatch = {} // index -> Set<opKey> (to be saved in state)
  const indexUsesReplace = new Set() // index
  const opsToDeleteFromQueue = []

  // Dynamic initialization of accumulators
  const ensureIndexInit = (index) => {
    if (!docsToAddOrUpdate[index]) docsToAddOrUpdate[index] = new Map()
    if (!keysToDelete[index]) keysToDelete[index] = new Set()
    if (!processedOpsInBatch[index]) processedOpsInBatch[index] = new Set()
    if (!systemState[index]) systemState[index] = new Set()
  }

  // Helper to get doc
  const getDoc = async (index, key, fallbackFn) => {
    ensureIndexInit(index)
    if (keysToDelete[index].has(key)) return fallbackFn ? fallbackFn() : null
    if (docsToAddOrUpdate[index].has(key)) return docsToAddOrUpdate[index].get(key)
    try {
      const doc = await mdb.index(index).getDocument(key)
      return doc
    } catch (err) {
      const notFound = (err && (err.code === 'document_not_found' || (err.cause && err.cause.code === 'document_not_found'))) || (err && err.response && err.response.status === 404)
      if (notFound) {
        return fallbackFn ? fallbackFn() : null
      }
      throw err
    }
  }

  for (const op of results) {
    const data = op.data || {}

    const opTargetKey = data.targetKey
    const opType = op.type
    let targetIndex = null
    let isProcessed = false

    try {
      // --- Dispatch Logic ---

      if (opType === 'insertOrReplaceDocument') {
        targetIndex = data.index
        ensureIndexInit(targetIndex)
        indexUsesReplace.add(targetIndex)

        if (systemState[targetIndex].has(op.key)) {
          isProcessed = true
        } else {
          const doc = data.document
          if (doc) {
            const pkField = getPkField(targetIndex)
            docsToAddOrUpdate[targetIndex].set(doc[pkField], doc)

            // If we are replacing, make sure we don't delete it
            if (keysToDelete[targetIndex].has(doc[pkField])) {
              keysToDelete[targetIndex].delete(doc[pkField])
            }
          }
        }
      } else if (opType === 'deleteDocumentIfExists') {
        targetIndex = data.index
        ensureIndexInit(targetIndex)

        if (systemState[targetIndex].has(op.key)) {
          isProcessed = true
        } else {
          const { key } = data
          if (key) {
            keysToDelete[targetIndex].add(key)
            docsToAddOrUpdate[targetIndex].delete(key)
          }
        }
      } else if (opType === 'patchDocumentIfExists') {
        targetIndex = data.index
        ensureIndexInit(targetIndex)

        if (systemState[targetIndex].has(op.key)) {
          isProcessed = true
        } else {
          const partialDoc = data.document
          const pkField = getPkField(targetIndex)
          const key = partialDoc[pkField]

          if (key) {
            // Must fetch full doc to merge, because MeiliSearch updateDocuments is partial update,
            // BUT we are simulating serial execution in memory.
            // So we need to merge with CURRENT accumulation state.
            const currentDoc = await getDoc(targetIndex, key, () => null) // If not exists, we can't patch
            if (currentDoc) {
              const merged = { ...currentDoc, ...partialDoc }
              docsToAddOrUpdate[targetIndex].set(key, merged)
              if (keysToDelete[targetIndex].has(key)) keysToDelete[targetIndex].delete(key)
            }
          }
        }
      } else if (opType === 'mergeSketch') {
        targetIndex = 'ipActivities'
        ensureIndexInit(targetIndex)

        if (systemState[targetIndex].has(op.key)) {
          isProcessed = true
        } else {
          const doc = await getDoc(targetIndex, opTargetKey, () => ({
            key: opTargetKey, data: createSketch().serialize().toString('base64url')
          }))

          if (doc && data.sketch) {
            let globalSketch
            try {
              const decompressed = await decompressAsync(Buffer.from(doc.data, 'base64url'))
              globalSketch = ConservativeCountMin.deserialize(decompressed)
            } catch (_err) {
              globalSketch = createSketch()
            }

            try {
              const incomingSketch = ConservativeCountMin.deserialize(await decompressAsync(Buffer.from(data.sketch, 'base64url')))
              globalSketch.merge(incomingSketch)
              const recompressed = await compressAsync(globalSketch.serialize())
              doc.data = recompressed.toString('base64url')
              docsToAddOrUpdate[targetIndex].set(opTargetKey, doc)
            } catch (err) {
              console.error('Failed to merge Sketch op', err)
            }
          }
        }
      } else if (opType === 'mergeHll') {
        targetIndex = 'requestedPubkeys'
        ensureIndexInit(targetIndex)

        if (systemState[targetIndex].has(op.key)) {
          isProcessed = true
        } else {
          const doc = await getDoc(targetIndex, opTargetKey, async () => ({
            key: opTargetKey,
            hll: bytesToBase64(await compressAsync(new HLL(0).getRegisters())),
            count: 0,
            firstSeenAt: Date.now()
          }))

          if (doc && data.hll) {
            const existingHll = HLL.newWithRegisters(await decompressAsync(base64ToBytes(doc.hll)), 0)
            const oldHllCount = existingHll.count()

            const incomingHll = HLL.newWithRegisters(await decompressAsync(base64ToBytes(data.hll)), 0)
            existingHll.merge(incomingHll)

            const newHllCount = existingHll.count()
            const delta = newHllCount - oldHllCount

            doc.hll = bytesToBase64(await compressAsync(existingHll.getRegisters()))
            // instead of `doc.count = existingHll.count()`
            // this way doc.count serves as a "Recent Popularity Score"
            // that we can decay, while the HLL continues to track unique
            // IP deduplication correctly
            doc.count = (doc.count || 0) + delta
            docsToAddOrUpdate[targetIndex].set(opTargetKey, doc)
          }
        }
      } else if (opType === 'deltaUsage' || opType === 'pruneCheck') {
        targetIndex = 'storedEventOwners'
        ensureIndexInit(targetIndex)

        if (systemState[targetIndex].has(op.key)) {
          isProcessed = true
        } else {
          const entityType = data.entityType || 'pubkey'

          const doc = await getDoc(targetIndex, opTargetKey, () => ({
            key: opTargetKey, entityType, usedBytes: 0, popularityLevel: 999
          }))

          if (doc) {
            doc.entityType = entityType
            if (data.popularityLevel !== undefined) doc.popularityLevel = data.popularityLevel

            if (opType === 'deltaUsage') {
              doc.usedBytes = (doc.usedBytes || 0) + (data.delta || 0)
            } else if (opType === 'pruneCheck') {
              const limit = data.limit || 0
              if (doc.usedBytes > limit) {
                // Side Effect: Pruning (Direct DB Deletes)
                // Note: `pruneEvents` performs direct deletes on 'events' index.
                // This is "out of band" of our transaction buffer.
                // But since `events` index deletes happen immediately, it's fine.
                // We just assume they succeed.
                const cleared = await pruneEvents({
                  ownerKey: opTargetKey,
                  ownerType: entityType,
                  bytesToRemove: doc.usedBytes - limit
                })
                doc.usedBytes = Math.max(0, doc.usedBytes - cleared)
              }
            }
            docsToAddOrUpdate[targetIndex].set(opTargetKey, doc)
          }
        }
      } else {
        console.warn(`Unknown op type: ${opType}`)
        // Consume it so we don't loop forever
        opsToDeleteFromQueue.push(op.key)
        continue
      }

      // --- End Logic ---

      if (isProcessed) {
        opsToDeleteFromQueue.push(op.key)
      } else if (targetIndex) {
        processedOpsInBatch[targetIndex].add(op.key)
        opsToDeleteFromQueue.push(op.key)
      }
    } catch (err) {
      // If DB is down, we must STOP. We should not consume the op.
      // Meilisearch communication errors or networking errors.
      const isNetworkError =
        err.name === 'MeiliSearchCommunicationError' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ENOTFOUND' ||
        err.cause?.code === 'ECONNREFUSED' ||
        err.cause?.code === 'ETIMEDOUT' ||
        err.cause?.code === 'ENOTFOUND'

      if (isNetworkError) {
        throw err
      }

      console.error(`Error processing op ${op.key} (${opType})`, err)
      // Avoid infinite retries: consume the op so it won't block the queue in tests
      try {
        opsToDeleteFromQueue.push(op.key)
      } catch {
        // ignore
      }
    }
  }

  // 4. Commit Batch per Index
  const indexesToCommit = Object.keys(docsToAddOrUpdate)
  const commitPromises = []

  for (const indexName of indexesToCommit) {
    const docs = Array.from(docsToAddOrUpdate[indexName].values())
    const keysDel = Array.from(keysToDelete[indexName])
    const processedIds = Array.from(processedOpsInBatch[indexName])

    const pkField = getPkField(indexName)

    if (docs.length === 0 && keysDel.length === 0 && processedIds.length === 0) continue

    // Include State Doc Upsert
    if (processedIds.length > 0) {
      const stateDoc = { [pkField]: SYSTEM_STATE_KEY, processedOpIds: processedIds }
      docs.push(stateDoc)
    }

    // We can run deletes and upserts for the same index in parallel usually,
    // but Meilisearch queues them anyway.
    // However, parallelizing across different indices is definitely beneficial.
    commitPromises.push((async () => {
      if (keysDel.length > 0) {
        await mdb.index(indexName).deleteDocuments(keysDel)
      }

      if (docs.length > 0) {
        // Use addDocuments (Replace) if any operation in the batch for this index was 'insertOrReplaceDocument'.
        // Otherwise, use updateDocuments (Merge) which is safer for partial updates/patches.
        // Since we simulate serialization in memory by fetching full docs, 'addDocuments' is generally safe too,
        // but 'updateDocuments' is more permissive if we somehow missed fields
        // (e.g. some other process updated a document outside of an operation).
        // However, 'insertOrReplaceDocument' STRICTLY requires 'addDocuments' to ensure deleted fields are removed.
        if (indexUsesReplace.has(indexName)) {
          await mdb.index(indexName).addDocuments(docs)
        } else {
          await mdb.index(indexName).updateDocuments(docs)
        }
      }
    })())
  }

  await Promise.all(commitPromises)

  // 5. Delete Ops from Pending
  if (opsToDeleteFromQueue.length > 0) {
    await mdb.index('pendingOps').deleteDocuments(opsToDeleteFromQueue)
  }
}

export default {
  key: 'processPendingOps',
  frequency: 5,
  shouldUseLock: true,
  // We want this to run indefinitely within the same process
  // even when there are no ops at the moment.
  // We may in the future remove it from the job list and make
  // it run on a dedicated worker process on pm2.
  maxDuration: Number.MAX_SAFE_INTEGER, // effectively no limit
  run
}
