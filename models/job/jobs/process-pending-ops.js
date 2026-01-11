import mdb from '#services/db/mdb.js'
import { getStoredEntity, pruneEvents } from '#services/event/maintainer/mdb/index.js'
import { CountMinSketch } from 'bloom-filters'
import { HyperLogLog as HLL } from 'nostr-hll/hyperloglog.js'
import { base64ToBytes, bytesToBase64 } from '#helpers/base64.js'
import { CMS_EPSILON, CMS_DELTA } from '#services/event/tracker/mdb/ip-activity.js'

const BATCH_SIZE = 50

// Queued operations by calling `queueOps(opsArray)` provide
// a soft-transaction mechanism by queueing them atomically.
// But there are no rollbacks.
export async function run () {
  console.log('Processing pending storage operations...')

  let hasMore = true
  while (hasMore) {
    // 1. Fetch Batch
    const { results } = await mdb.index('pendingOps').getDocuments({
      limit: BATCH_SIZE,
      sort: ['createdAt:asc']
    })

    if (results.length === 0) {
      hasMore = false
      break
    }

    // 2. Group by Owner (targetKey)
    const opsByOwner = {}
    for (const op of results) {
      if (!opsByOwner[op.targetKey]) opsByOwner[op.targetKey] = []
      opsByOwner[op.targetKey].push(op)
    }

    // 3. Process each owner
    for (const [targetKey, ops] of Object.entries(opsByOwner)) {
      try {
        const firstOpData = ops[0].data ? JSON.parse(ops[0].data) : {}
        const ownerType = firstOpData.ownerType || 'pk' // Fallback

        // Check for special stats merge ops
        const hasMergeCMS = ops.some(op => op.type === 'merge_cms')
        const hasMergeHLL = ops.some(op => op.type === 'merge_hll')

        if (hasMergeCMS) {
          // --- Strategy C: CMS ---
          const processedIds = new Set() // For CMS, maybe we track in separate doc or just process blindly?
          // Since this job is locked, and we only delete from pendingOps AFTER processing...
          // If we crash mid-save, we might re-process. Merging CMS is NOT idempotent.
          // We need idempotency. We should store processed_op_ids in the CMS doc ideally.
          let globalCMS
          try {
            const doc = await mdb.index('ipActivity').getDocument(targetKey)
            globalCMS = CountMinSketch.fromJSON(JSON.parse(doc.json))
            if (doc.processed_op_ids) doc.processed_op_ids.forEach(id => processedIds.add(id))
          } catch (err) {
            if (err.code === 'document_not_found') {
              globalCMS = new CountMinSketch(CMS_EPSILON, CMS_DELTA)
            } else throw err
          }

          const opsToProcess = []
          const opsToDelete = []
          for (const op of ops) {
            if (processedIds.has(op.key)) opsToDelete.push(op.key)
            else if (op.type === 'merge_cms') opsToProcess.push(op)
          }

          if (opsToProcess.length > 0) {
            for (const op of opsToProcess) {
              const data = JSON.parse(op.data)
              const partialCMS = CountMinSketch.fromJSON(data.cms)
              globalCMS.merge(partialCMS)
            }

            const currentBatchIds = opsToProcess.map(op => op.key)
            await mdb.index('ipActivity').addDocuments([{
              key: targetKey,
              json: JSON.stringify(globalCMS.saveAsJSON()),
              processed_op_ids: currentBatchIds
            }])
            opsToDelete.push(...currentBatchIds)
          }

          if (opsToDelete.length > 0) {
            await mdb.index('pendingOps').deleteDocuments(opsToDelete)
          }
        }

        if (hasMergeHLL) {
          // --- Strategy B: HLL ---
          const processedIds = new Set()
          let existingHll = new HLL(0)

          try {
            const doc = await mdb.index('requestedPubkeys').getDocument(targetKey)
            if (doc.hll) existingHll = HLL.newWithRegisters(base64ToBytes(doc.hll), 0)
            if (doc.processed_op_ids) doc.processed_op_ids.forEach(id => processedIds.add(id))
          } catch (err) {
            if (err.code !== 'document_not_found') throw err
          }

          const opsToProcess = []
          const opsToDelete = []
          for (const op of ops) {
            if (processedIds.has(op.key)) opsToDelete.push(op.key)
            else if (op.type === 'merge_hll') opsToProcess.push(op)
          }

          if (opsToProcess.length > 0) {
            for (const op of opsToProcess) {
              const data = JSON.parse(op.data)
              const incomingHll = HLL.newWithRegisters(base64ToBytes(data.hll), 0)
              existingHll.merge(incomingHll)
            }

            const currentBatchIds = opsToProcess.map(op => op.key)
            await mdb.index('requestedPubkeys').updateDocuments([{ // upsert
              key: targetKey,
              hll: bytesToBase64(existingHll.getRegisters()),
              count: existingHll.count(),
              processed_op_ids: currentBatchIds
            }])
            opsToDelete.push(...currentBatchIds)
          }

          if (opsToDelete.length > 0) {
            await mdb.index('pendingOps').deleteDocuments(opsToDelete)
          }
        }

        // --- Strategy A: Standard (Storage/Pruning) ---
        // Load Owner State
        const storedEntity = await getStoredEntity({ key: targetKey, type: ownerType })
        let popularityLevel = storedEntity.popularityLevel !== undefined ? storedEntity.popularityLevel : 999

        // Check for already processed ops (Crash Recovery)
        const processedIds = new Set(storedEntity.processed_op_ids || [])
        const opsToProcess = []
        const opsToDelete = []

        const STANDARD_TYPES = new Set(['save_event', 'delete_event', 'delta_usage', 'prune_check'])

        for (const op of ops) {
          if (processedIds.has(op.key)) {
            opsToDelete.push(op.key) // Already applied, just need to cleanup
          } else if (STANDARD_TYPES.has(op.type)) {
            opsToProcess.push(op)
          }
        }

        if (opsToProcess.length === 0 && opsToDelete.length === 0) continue

        // Calculate Logic
        let newUsage = storedEntity.usedBytes || 0
        let shouldPrune = false
        let pruneLimit = 0

        const eventsToAdd = []
        const eventIdsToDelete = []

        for (const op of opsToProcess) {
          const data = JSON.parse(op.data)

          // If operation provides a fresh popularity level, update it
          if (data.popularityLevel !== undefined) {
            popularityLevel = data.popularityLevel
          }

          if (op.type === 'delta_usage') {
            newUsage += (data.delta || 0)
          } else if (op.type === 'prune_check') {
            shouldPrune = true
            pruneLimit = data.limit || 0
          } else if (op.type === 'save_event') {
            if (data.event) eventsToAdd.push(data.event)
          } else if (op.type === 'delete_event') {
            if (data.id) eventIdsToDelete.push(data.id)
          }
        }

        // Apply Logic

        // 1. Storage Operations (Soft Transaction part 1: The Events)
        if (eventsToAdd.length > 0) {
          await mdb.index('events').addDocuments(eventsToAdd)
        }
        if (eventIdsToDelete.length > 0) {
          await mdb.index('events').deleteDocuments(eventIdsToDelete)
        }
        // 2. Pruning (if required)
        if (shouldPrune && newUsage > pruneLimit) {
          const bytesToRemove = newUsage - pruneLimit
          // This may be slow, blocking other owners in this simple loop.
          // In high scale, this loop should be parallelized.
          const cleared = await pruneEvents({ ownerKey: targetKey, ownerType, bytesToRemove })
          newUsage -= cleared
        }

        newUsage = Math.max(0, newUsage)
        const currentBatchIds = opsToProcess.map(op => op.key)

        // 4. COMMIT (Checkpoint)
        // We update the owner with new usage AND the IDs we just processed.
        // If we processed nothing (only cleanup), we don't strictly need to update usage,
        // but we might want to clear `processed_op_ids`?
        // Actually, collecting IDs effectively processed this turn:
        // If we had opsToDelete (recovered), they are already in DB.
        // If we successfully delete them from pendingOps, we should eventually remove them from storedEntity too to keep it clean.
        // But for now, let's overwrite processed_op_ids with CURRENT batch IDs.
        // Wait! If `opsToDelete` were from PREVIOUS batch that crashed.
        // If we overwrite `processed_op_ids` with `currentBatchIds`, we lose the record of `opsToDelete`.
        // BUT `opsToDelete` are effectively handled if we delete them from `pendingOps` right now.
        // The safest order:
        // 1. Process new ops.
        // 2. Commit `processed_op_ids` = `[...currentBatchIds]`. (This invalidates previous IDs from the field, which is fine because if they were in `opsToDelete`, we are about to delete them from pending anyway).
        // 3. Delete `[...opsToDelete, ...currentBatchIds]` from `pendingOps`.

        if (opsToProcess.length > 0) {
          await mdb.index('storedEventOwners').updateDocuments([{
            key: targetKey,
            entity: ownerType,
            usedBytes: newUsage,
            popularityLevel,
            processed_op_ids: currentBatchIds
          }])
        } else if (opsToDelete.length > 0) {
          // If we only have deletions (cleanup), we don't need to commit usage.
          // However, if we delete them from pendingOps, they are gone.
          // We might want to clear processed_op_ids from DB?
          // Not strictly necessary but cleaner.
          await mdb.index('storedEventOwners').updateDocuments([{
            key: targetKey,
            entity: ownerType,
            processed_op_ids: [] // Clear
          }])
        }

        // 5. FINALIZE (Delete Ops)
        const allIdsToDelete = [...opsToDelete, ...currentBatchIds]
        if (allIdsToDelete.length > 0) {
          await mdb.index('pendingOps').deleteDocuments(allIdsToDelete)
        }
      } catch (err) {
        console.error(`Error processing ops for ${targetKey}`, err)
        // Skip this owner, try next
      }
    }
  }
  console.log('Done processing pending storage operations.')
}

const config = {
  key: 'processPendingOps',
  frequency: 5,
  shouldUseLock: true,
  run
}

export default config
