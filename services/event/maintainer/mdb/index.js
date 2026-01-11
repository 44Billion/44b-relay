import { CuckooFilter } from 'bloom-filters'
import mdb from '#services/db/mdb.js'
import crypto from 'node:crypto'

const ONE_MB = 1024 * 1024
const EVENT_BATCH_SIZE = 20

// Estimated limits
const STORAGE_LIMITS = {
  1: 500 * ONE_MB,
  2: 300 * ONE_MB,
  3: 150 * ONE_MB,
  4: 70 * ONE_MB,
  5: 20 * ONE_MB,
  DEFAULT: 10 * ONE_MB
}

const popularCuckooFilters = {
  1: { normal: null, relegated: null },
  2: { normal: null, relegated: null },
  3: { normal: null, relegated: null },
  4: { normal: null, relegated: null },
  5: { normal: null, relegated: null },
  6: { normal: null, relegated: null }
}

let lastCuckooUpdate = 0
const CUCKOO_UPDATE_INTERVAL = 10 * 60 * 1000 // 10 minutes cache

async function loadPopularityFilters () {
  if (Date.now() - lastCuckooUpdate < CUCKOO_UPDATE_INTERVAL && popularCuckooFilters[1].normal) {
    return
  }

  try {
    const { results } = await mdb.index('popularPubkeys').getDocuments({ limit: 6 })
    if (results.length === 0) return

    for (const doc of results) {
      // doc.key is the level (e.g., "1", "2")
      const level = parseInt(doc.key)
      if (level >= 1 && level <= 6) {
        if (doc.cuckoo) {
          popularCuckooFilters[level].normal = CuckooFilter.fromJSON(JSON.parse(doc.cuckoo)) // Assuming JSON stored
        }
        if (doc.relegatedCuckoo) {
          popularCuckooFilters[level].relegated = CuckooFilter.fromJSON(JSON.parse(doc.relegatedCuckoo))
        }
      }
    }
    lastCuckooUpdate = Date.now()
  } catch (err) {
    console.error('Failed to load popular cuckoos', err)
  }
}

function getPopularityLevel (pubkey) {
  for (let level = 1; level <= 5; level++) {
    const filter = popularCuckooFilters[level]
    if (filter.normal?.has(pubkey) || filter.relegated?.has(pubkey)) {
      return level
    }
  }
  return 999
}

function getStorageLimit (popularityLevel) {
  return STORAGE_LIMITS[popularityLevel] || STORAGE_LIMITS.DEFAULT
}

async function getStoredEntity ({ key, type }) {
  try {
    return await mdb.index('storedEventOwners').getDocument(key)
  } catch (e) {
    if (e.code === 'document_not_found') {
      return { key, entity: type, usedBytes: 0, popularityLevel: 999 }
    }
    throw e
  }
}

async function pruneEvents ({ ownerKey, ownerType, bytesToRemove }) {
  if (ownerType === 'ip') await loadPopularityFilters()

  let cleared = 0
  let offset = 0

  while (cleared < bytesToRemove) {
    // Fetch oldest events
    const filter = ownerType === 'pk'
      ? `pubkey = ${mdb.toMeiliValue(ownerKey)} AND owner = "pk"`
      : `ip = ${mdb.toMeiliValue(ownerKey)} AND owner = "ip"`

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

    if (ownerType === 'pk') {
      const idsToDelete = hits.map(h => h.ref || h.id)
      bytesInBatch = hits.reduce((acc, h) => acc + (h.byteSize || 0), 0)
      await mdb.index('events').deleteDocuments(idsToDelete)
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
        const ids = eventsToDelete.map(h => h.ref || h.id)
        await mdb.index('events').deleteDocuments(ids)
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

        // 3. Queue event updates (changing owner to 'pk') atomically with usage update
        const updates = events.map(ev => ({ ...ev, owner: 'pk' }))
        updates.forEach(ev => {
          ops.push({
            targetKey: pubkey,
            type: 'save_event',
            data: { event: ev, ownerType: 'pk' }
          })
        })

        await queueOps(ops)
      }
    }
  }
  return cleared
}

async function queueOps (ops) {
  if (!ops || ops.length === 0) return
  const now = Date.now()
  const documents = ops.map(op => ({
    key: crypto.randomUUID(),
    targetKey: op.targetKey,
    type: op.type,
    data: JSON.stringify(op.data),
    createdAt: now
  }))
  await mdb.index('pendingOps').addDocuments(documents)
}

export async function checkStorageLimitAndPrune ({ pubkey, ip, newEventSize, popularityLevel }) {
  if (popularityLevel === undefined) {
    await loadPopularityFilters()
    popularityLevel = getPopularityLevel(pubkey)
  }
  const level = popularityLevel

  const ownerType = level <= 5 ? 'pk' : 'ip'
  const ownerKey = ownerType === 'pk' ? pubkey : ip
  const limit = getStorageLimit(level)

  const ops = []

  // Queue the usage update
  ops.push({
    targetKey: ownerKey,
    type: 'delta_usage',
    data: { delta: newEventSize, ownerType, popularityLevel: level }
  })

  // We optimize by checking current usage (even if slightly stale) to see if we should queue a prune check
  // We don't strictly need to queue 'prune' if we are far from limit, to save job processing time.
  // But if we are close or over, we queue it.

  try {
    const storedEntity = await getStoredEntity({ key: ownerKey, type: ownerType })
    const currentUsage = storedEntity.usedBytes || 0

    // We queue a prune check if we are over limit OR close to it (e.g. > 90%)
    if (currentUsage + newEventSize > limit * 0.9) {
      ops.push({
        targetKey: ownerKey,
        type: 'prune_check',
        data: { limit, ownerType, popularityLevel: level }
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
