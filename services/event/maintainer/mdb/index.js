import { unpackFilter } from '#helpers/bloom.js'
import mdb from '#services/db/mdb.js'
import crypto from 'node:crypto'
import { ipToPrimaryKey, isValidPrimaryKey } from '#helpers/mdb.js'
import { base16ToBytes } from 'libp2r2p/base16'
import { getRelaySelfPubkey } from '#helpers/relay-self.js'
import { RELAY_OWNED_KINDS } from '#constants/event.js'
import { PENDING_OPS_SORT } from '#models/pending-op/order.js'
import {
  getPruneTargetBytes,
  PRUNE_WORKFLOW_VERSION
} from '#services/event/prune-policy.js'

const ONE_MB = 1024 * 1024

export const VIP_PUBKEYS = new Set([
  getRelaySelfPubkey(),
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

async function loadPopularityFilters ({ force = false } = {}) {
  if (!force &&
      Date.now() - lastFilterUpdate < FILTER_UPDATE_INTERVAL &&
      popularFilters[1].normal) {
    return
  }

  try {
    if (force) {
      for (let level = 1; level <= 6; level++) {
        popularFilters[level].normal = null
        popularFilters[level].relegated = null
      }
    }
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

const queueOps = (() => {
  async function queueOps (ops) {
    if (!ops || ops.length === 0) return
    const now = Date.now()
    const batchId = crypto.randomUUID()
    // A prune reads the writes represented by its logical batch. Keep all
    // other relative ordering intact while placing quota enforcement last.
    const orderedOps = [
      ...ops.filter(op => op.type !== 'pruneCheck'),
      ...ops.filter(op => op.type === 'pruneCheck')
    ]
    const documents = orderedOps.map((op, position) => {
      const phase = op.phase ?? 'queued'
      return {
        key: op.key || crypto.randomUUID(),
        type: op.type,
        data: op.data,
        batchId,
        position,
        phase,
        ...(phase !== 'queued' ? { startedAt: now } : {}),
        ...(![null, undefined].includes(op.reservationKey) ? { reservationKey: op.reservationKey } : {}),
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
        const { hits } = await mdb.index('pendingOps').search('', { limit: 1000, sort: PENDING_OPS_SORT })
        const processPendingOps = await import('#models/job/jobs/process-pending-ops/index.js')
        const state = await processPendingOps.loadSystemState()
        await processPendingOps.processBatch(hits, state)
      }
      await queueOps(ops)
      await runSingleBatch()
    }
    : queueOps
})()

export async function checkStorageLimitAndPrune ({ pubkey, ip, newEventSize, popularityLevel, kind }) {
  if (RELAY_OWNED_KINDS.has(kind)) {
    return { ownerType: 'pubkey', ownerKey: getRelaySelfPubkey(), popularityLevel: 999, ops: [] }
  }

  if (popularityLevel === undefined) {
    await loadPopularityFilters()
    popularityLevel = getPopularityLevel(pubkey)
  }
  const isVip = VIP_PUBKEYS.has(pubkey)

  const ownerType = isVip ? 'pubkey' : (popularityLevel <= 5 ? 'pubkey' : 'ip')
  const ownerKey = ownerType === 'pubkey' ? pubkey : ipToPrimaryKey(ip)
  const limit = getStorageLimit(popularityLevel)

  const ops = []

  // Queue the usage update
  ops.push({
    type: 'deltaUsage',
    data: { key: ownerKey, delta: newEventSize, entityType: ownerType, popularityLevel }
  })

  // We optimize by checking current usage (even if slightly stale) to see if we should queue a prune check
  // We don't strictly need to queue 'prune' if we are far from limit, to save job processing time.
  // But if we are close or over, we queue it.

  if (isVip) return { ownerType, ownerKey, popularityLevel, ops }

  try {
    const storedEntity = await getStoredEntity({ key: ownerKey, type: ownerType })
    const currentUsage = storedEntity.usedBytes || 0

    // We queue a prune check if we are over limit OR close to it (e.g. > 90%)
    if (currentUsage + newEventSize > limit * 0.9) {
      ops.push({
        type: 'pruneCheck',
        data: {
          key: ownerKey,
          limit,
          targetBytes: getPruneTargetBytes(limit),
          entityType: ownerType,
          popularityLevel,
          workflowVersion: PRUNE_WORKFLOW_VERSION,
          step: 0
        }
      })
    }
  } catch (err) {
    console.log('Error reading entity. Can\'t schedule prune check for', ownerKey, err)
  }

  return { ownerType, ownerKey, popularityLevel, ops }
}

export {
  loadPopularityFilters,
  getPopularityLevel,
  getStorageLimit,
  getStoredEntity,
  queueOps
}
