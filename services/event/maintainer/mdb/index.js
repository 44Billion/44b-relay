import { unpackFilter } from '#helpers/bloom.js'
import mdb from '#services/db/mdb.js'
import crypto from 'node:crypto'
import { primaryKeyToIp, ipToPrimaryKey, isValidPrimaryKey } from '#helpers/mdb.js'
import { base16ToBytes } from '#helpers/base16.js'

const ONE_MB = 1024 * 1024
const EVENT_BATCH_SIZE = 20

export const VIP_PUBKEYS = new Set([
  'fc7085c383ba71745704bdc1c6efcf7fab0197501de598c5e6c537ac0b32a4cb', // arthurfranca - npub1l3cgtsurhfchg4cyhhqudm70074sr96srhje330xc5m6czej5n9s9q6vs2
  '5a8bc85694d8fbb4f30208649c1c52509636d1e6fdb1f0f4c84a3f10f9383ec9' // 44b mirror - npub1t29us455mramfuczppjfc8zj2ztrd50xlkclpaxgfgl3p7fc8mysjuvsrw
])

// Estimated limits
const STORAGE_LIMITS = {
  1: 500 * ONE_MB,
  2: 300 * ONE_MB,
  3: 150 * ONE_MB,
  4: 70 * ONE_MB,
  5: 20 * ONE_MB,
  // Level 6 doesn't have a special limit, cause these
  // pubkeys are considered on the rise but not yet popular.
  // Level 6 events are still stored under 'ip' ownership
  // so they share the same limit as non-popular (999).
  // Events from pubkeys up to level 6 aren't considered spam.
  DEFAULT: 10 * ONE_MB
}

const popularFilters = {
  1: { normal: null, relegated: null },
  2: { normal: null, relegated: null },
  3: { normal: null, relegated: null },
  4: { normal: null, relegated: null },
  5: { normal: null, relegated: null },
  6: { normal: null, relegated: null }
}

let lastFilterUpdate = 0
const FILTER_UPDATE_INTERVAL = 10 * 60 * 1000 // 10 minutes cache

async function loadPopularityFilters () {
  if (Date.now() - lastFilterUpdate < FILTER_UPDATE_INTERVAL && popularFilters[1].normal) {
    return
  }

  try {
    const { results } = await mdb.index('popularPubkeys').getDocuments({ limit: 6 })
    if (results.length === 0) return

    for (const doc of results) {
      // doc.key is the level (e.g., "1", "2")
      const level = parseInt(doc.key)
      if (level >= 1 && level <= 6) {
        if (doc.filter) {
          popularFilters[level].normal = await unpackFilter(doc.filter)
        }
        if (doc.relegatedFilter) {
          popularFilters[level].relegated = await unpackFilter(doc.relegatedFilter)
        }
      }
    }
    lastFilterUpdate = Date.now()
  } catch (err) {
    console.error('Failed to load popular filters', err)
  }
}

function getPopularityLevel (pubkey) {
  if (process.env.IS_INTEGRATION_TEST === 'true') return 6

  const pubkeyBytes = base16ToBytes(pubkey)
  for (let level = 1; level <= 6; level++) {
    const filter = popularFilters[level]
    if (filter.normal?.has(pubkeyBytes) || filter.relegated?.has(pubkeyBytes)) {
      return level
    }
  }

  if (VIP_PUBKEYS.has(pubkey)) return 6

  return 999
}

function getStorageLimit (popularityLevel) {
  return STORAGE_LIMITS[popularityLevel] || STORAGE_LIMITS.DEFAULT
}

async function getStoredEntity ({ key, type }) {
  // Do this outside: `const primaryKey = type === 'ip' ? ipToPrimaryKey(key) : key`
  if (!isValidPrimaryKey(key)) throw new Error('Invalid primary key format')
  try {
    return await mdb.index('storedEventOwners').getDocument(key)
  } catch (e) {
    if (e.code === 'document_not_found' || e.cause?.code === 'document_not_found') {
      return { key, entityType: type, usedBytes: 0, popularityLevel: 999 }
    }
    throw e
  }
}

async function pruneEvents ({ ownerKey, ownerType, bytesToRemove }) {
  if (!isValidPrimaryKey(ownerKey)) throw new Error('Invalid primary key format')
  if (ownerType === 'ip') await loadPopularityFilters()
  else if (VIP_PUBKEYS.has(ownerKey)) return 0

  let cleared = 0
  let offset = 0

  while (cleared < bytesToRemove) {
    // Fetch oldest events
    const filter = ownerType === 'pubkey'
      ? `pubkey = ${mdb.toMeiliValue(ownerKey)} AND ownerType = "pubkey"`
      : `ip = ${mdb.toMeiliValue(primaryKeyToIp(ownerKey))} AND ownerType = "ip"`

    const searchRes = await mdb.index('events').search('', {
      filter,
      sort: ['created_at:asc'], // Delete oldest
      limit: EVENT_BATCH_SIZE,
      offset
    })

    if (searchRes.hits.length === 0) break

    // We increase offset for the next iteration to skip the docs we are about to delete/move.
    // This assumes Meilisearch might not reflect the changes immediately in the next search query.
    offset += searchRes.hits.length

    const hits = searchRes.hits
    let bytesInBatch = 0

    if (ownerType === 'pubkey') {
      const keysToDelete = hits.map(h => h.ref)
      // Clear all of the batch even if cleared >= bytesToRemove
      // so to postpone a proosible next purging need for this same owner.
      bytesInBatch = hits.reduce((acc, h) => acc + (h.byteSize || 0), 0)
      await mdb.index('events').deleteDocuments(keysToDelete)
      cleared += bytesInBatch
    } else {
      // Owner is IP: Check for popular pubkeys to promote/restore
      const eventsToDelete = []
      const eventsToPromote = {} // pubkey -> events[]

      for (const event of hits) {
        const level = getPopularityLevel(event.pubkey)
        if (level <= 5) {
          if (!eventsToPromote[event.pubkey]) eventsToPromote[event.pubkey] = []
          eventsToPromote[event.pubkey].push(event)
        } else {
          eventsToDelete.push(event)
        }
      }

      // Delete non-popular
      if (eventsToDelete.length > 0) {
        const keysToDelete = eventsToDelete.map(h => h.ref)
        await mdb.index('events').deleteDocuments(keysToDelete)
        const size = eventsToDelete.reduce((acc, h) => acc + (h.byteSize || 0), 0)
        cleared += size
      }

      // Promote popular
      for (const [pubkey, events] of Object.entries(eventsToPromote)) {
        // 1. Count as cleared for the IP
        const size = events.reduce((acc, h) => acc + (h.byteSize || 0), 0)
        cleared += size

        // 2. Prepare usage update for the new PK owner
        const { ops } = await checkStorageLimitAndPrune({
          pubkey,
          ip: null,
          newEventSize: size,
          popularityLevel: getPopularityLevel(pubkey)
        })

        // 3. Queue event updates (changing ownerType to 'pubkey') atomically with usage update
        events.forEach(ev => {
          ops.push({
            type: 'patchDocumentIfExists',
            data: { index: 'events', document: { ref: ev.ref, ownerType: 'pubkey' } }
          })
        })

        await queueOps(ops)
      }
    }
  }
  return cleared
}

const queueOps = (() => {
  async function queueOps (ops) {
    if (!ops || ops.length === 0) return
    const now = Date.now()
    const documents = ops.map(op => {
      return {
        key: crypto.randomUUID(),
        type: op.type,
        data: op.data,
        ...(![null, undefined].includes(op.source) ? { source: op.source } : {}),
        createdAt: now
      }
    })
    await mdb.index('pendingOps').addDocuments(documents)
  }
  // If integration tests are running, process instantly
  return process.env.IS_INTEGRATION_TEST === 'true'
    ? async (ops) => {
      async function runSingleBatch () {
        const { hits } = await mdb.index('pendingOps').search('', { limit: 1000, sort: ['createdAt:asc'] })
        const processPendingOps = await import('#models/job/jobs/process-pending-ops/index.js')
        const state = await processPendingOps.loadSystemState()
        await processPendingOps.processBatch(hits, state)
      }
      await queueOps(ops)
      await runSingleBatch()
    }
    : queueOps
})()

export async function checkStorageLimitAndPrune ({ pubkey, ip, newEventSize, popularityLevel }) {
  if (popularityLevel === undefined) {
    await loadPopularityFilters()
    popularityLevel = getPopularityLevel(pubkey)
  }
  const level = popularityLevel
  const isVip = VIP_PUBKEYS.has(pubkey)

  const ownerType = isVip ? 'pubkey' : (level <= 5 ? 'pubkey' : 'ip')
  const ownerKey = ownerType === 'pubkey' ? pubkey : ipToPrimaryKey(ip)
  const limit = getStorageLimit(level)

  const ops = []

  // Queue the usage update
  ops.push({
    type: 'deltaUsage',
    data: { targetKey: ownerKey, delta: newEventSize, entityType: ownerType, popularityLevel: level }
  })

  // We optimize by checking current usage (even if slightly stale) to see if we should queue a prune check
  // We don't strictly need to queue 'prune' if we are far from limit, to save job processing time.
  // But if we are close or over, we queue it.

  if (isVip) return { ownerType, ownerKey, popularityLevel: level, ops }

  try {
    const storedEntity = await getStoredEntity({ key: ownerKey, type: ownerType })
    const currentUsage = storedEntity.usedBytes || 0

    // We queue a prune check if we are over limit OR close to it (e.g. > 90%)
    if (currentUsage + newEventSize > limit * 0.9) {
      ops.push({
        type: 'pruneCheck',
        data: { targetKey: ownerKey, limit, entityType: ownerType, popularityLevel: level }
      })
    }
  } catch (_e) {
    // If error reading entity, we might still want to queue the check just in case?
    // Or just ignore.
  }

  return { ownerType, ownerKey, popularityLevel: level, ops }
}

export {
  loadPopularityFilters,
  getPopularityLevel,
  pruneEvents,
  getStoredEntity,
  queueOps
}
