import mdb from '#services/db/mdb.js'
import { queueOps } from '#services/event/maintainer/mdb/index.js'
import { eventKinds } from '#constants/event.js'
import { ipToPrimaryKey } from '#helpers/mdb.js'
import { recordToEvent } from '#models/event/mapper.js'
import { validateIrfsChunkEvent } from '#services/event/irfs-chunk-validator.js'

const BATCH_SIZE = 100
const GRACE_PERIOD_SECONDS = 60 * 60 * 24 * 3
const ROOT_HASH = /^[0-9a-f]{64}$/

// Loads all explicit blob references for one author in bounded pages. blobRefs
// is derived from every r tag before the ten-tag indexing split.
async function collectBlobRefsForPubkey (pubkey) {
  const roots = new Set()
  let offset = 0
  while (true) {
    const { results } = await mdb.index('events').getDocuments({
      filter: `pubkey = ${mdb.toMeiliValue(pubkey)} AND blobRefs EXISTS`,
      limit: BATCH_SIZE,
      offset,
      fields: ['blobRefs']
    })
    for (const hit of results) {
      for (const root of hit.blobRefs || []) if (ROOT_HASH.test(root)) roots.add(root)
    }
    if (results.length < BATCH_SIZE) break
    offset += results.length
  }
  return roots
}

function hasValidDerivedMetadata (hit) {
  return ROOT_HASH.test(hit.mmrRoot) &&
    Number.isSafeInteger(hit.mmrIndex) && hit.mmrIndex >= 0 &&
    Number.isSafeInteger(hit.mmrTotal) && hit.mmrTotal > 0 &&
    hit.mmrIndex < hit.mmrTotal
}

function isValidStoredChunk (hit) {
  if (!hasValidDerivedMetadata(hit)) return false
  try {
    const derived = validateIrfsChunkEvent(recordToEvent(hit))
    return derived.mmrRoot === hit.mmrRoot &&
      derived.mmrIndex === hit.mmrIndex &&
      derived.mmrTotal === hit.mmrTotal
  } catch (_) {
    return false
  }
}

async function collectChunkPubkeys () {
  const pubkeys = new Set()
  let offset = 0
  while (true) {
    const { results } = await mdb.index('events').getDocuments({
      filter: `kind = ${eventKinds.BINARY_DATA_CHUNK}`,
      limit: BATCH_SIZE,
      offset,
      fields: ['pubkey']
    })
    for (const hit of results) if (hit.pubkey) pubkeys.add(hit.pubkey)
    if (results.length < BATCH_SIZE) break
    offset += results.length
  }
  return pubkeys
}

async function deleteStaleChunks () {
  const receivedBefore = Math.floor(Date.now() / 1000) - GRACE_PERIOD_SECONDS
  const pubkeys = await collectChunkPubkeys()
  let deletedCount = 0

  for (const pubkey of pubkeys) {
    const referencedRoots = await collectBlobRefsForPubkey(pubkey)
    let offset = 0
    const usageDeltas = new Map()

    while (true) {
      const { results } = await mdb.index('events').getDocuments({
        filter: `kind = ${eventKinds.BINARY_DATA_CHUNK} AND pubkey = ${mdb.toMeiliValue(pubkey)}`,
        limit: BATCH_SIZE,
        offset
      })
      if (!results.length) break
      const ops = []
      for (const hit of results) {
        const invalid = !isValidStoredChunk(hit)
        const oldAndUnreferenced = hit.receivedAt <= receivedBefore && !referencedRoots.has(hit.mmrRoot)
        if (!invalid && !oldAndUnreferenced) continue
        ops.push({ type: 'deleteDocumentIfExists', data: { index: 'events', key: hit.ref } })
        const ownerType = hit.ownerType === 'ip' ? 'ip' : 'pubkey'
        const key = ownerType === 'ip' ? ipToPrimaryKey(hit.ip) : hit.pubkey
        if (key) {
          const usageKey = `${ownerType}:${key}`
          const usage = usageDeltas.get(usageKey) || { ownerType, key, delta: 0 }
          usage.delta -= hit.byteSize || 0
          usageDeltas.set(usageKey, usage)
        }
      }
      if (ops.length) {
        await queueOps(ops)
        deletedCount += ops.length
      }
      if (results.length < BATCH_SIZE) break
      offset += results.length
    }

    const usageOps = [...usageDeltas.values()].filter(usage => usage.delta < 0).map(usage => ({
      type: 'deltaUsage',
      data: { key: usage.key, delta: usage.delta, entityType: usage.ownerType }
    }))
    if (usageOps.length) await queueOps(usageOps)
  }
  console.log(`Queued ${deletedCount} invalid or stale chunks for deletion`)
}

export async function run () {
  console.log('Running deleteStaleChunks job...')
  await deleteStaleChunks()
  console.log('Done deleteStaleChunks job.')
}

export { collectBlobRefsForPubkey, hasValidDerivedMetadata, isValidStoredChunk }

export default {
  key: 'deleteStaleChunks',
  frequency: 60 * 60 * 24,
  shouldUseLock: true,
  run
}
