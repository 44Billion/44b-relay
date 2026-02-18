import { HyperLogLog as HLL } from 'nostr-hll/hyperloglog.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToBase64 } from '#helpers/base64.js'
import { eventKinds } from '#constants/event.js'
import { queueOps } from '#services/event/maintainer/mdb/index.js'
import { compressAsync } from '#helpers/buffer.js'
import { getIpScore } from './ip-activity.js'
import { shuffle } from '#helpers/array.js'
import mdb from '#services/db/mdb.js'

// 1,000 requests per 24h window (48h now that we use sliding window)
// If an IP exceeds this, their votes for "popularity" are ignored.
const SPAM_SCORE_THRESHOLD = 1000

// Cache to hold HLL objects in memory before flushing
// Map<Pubkey, HLL>
const requestedPubkeysCache = new Map()
const utf8Encoder = new TextEncoder()

// Pruning Configuration
const MAX_DOCS = 2000000 // 2 Million
const TARGET_DOCS = 1000000 // 1 Million (Trim to half)
let lastCachedCount = 0
let pendingOpsCount = 0

// Stats Check Configuration
const PROCESSES_COUNT = 2
const CHECK_INTERVAL = 60 // Check at least once an hour (approx 60 flushes)
let flushesSinceLastCheck = 0

// These kinds may have been requested just
// to enhance the profile of a spammer account
// on a thread UI, not exactly because the vieweing user
// is on the other user's profile page. The former
// isn't interesting for us to track.
export const uninterestedIn = {
  kinds: {
    [eventKinds.METADATA]: true, // 0
    [eventKinds.RELAY_LIST_METADATA]: true // 10002
  }
}
export function getFilterInterests ({ filters }) {
  const interestingIds = {}
  const interestingPubkeys = new Set()
  for (const filter of filters) {
    const hasAuthors = filter.authors && filter.authors.length > 0
    const hasIds = filter.ids && filter.ids.length > 0
    if (hasAuthors) {
      for (const author of filter.authors) {
        interestingPubkeys.add(author)
      }
    // Only consider ids if there are no authors in the filter
    } else if (hasIds) {
      for (const id of filter.ids) {
        interestingIds[id] = true
      }
    }
  }
  return { ids: interestingIds, pubkeys: interestingPubkeys }
}

export function trackRequestedPubkeys ({ pubkeys, ip }) {
  // Spam Mitigation
  if (getIpScore(ip) > SPAM_SCORE_THRESHOLD) return

  // We slice to 50 random pubkeys to avoid a single IP
  // bloating the requestedPubkeys mdb index
  for (const pubkey of shuffle(pubkeys).slice(0, 50)) {
    let hll = requestedPubkeysCache.get(pubkey)
    if (!hll) {
      hll = new HLL(0)
      requestedPubkeysCache.set(pubkey, hll)
    }
    hll.add(sha256(utf8Encoder.encode(ip)))
  }
}

async function pruneRequestedPubkeys (amountToDelete) {
  if (amountToDelete <= 0) return

  const index = mdb.index('requestedPubkeys')
  const now = Date.now()
  const twoHoursAgo = now - (2 * 60 * 60 * 1000)

  // 1. Try deleting newcomers protected (firstSeenAt < 2 hours ago)
  // Logic: "filtering out newcomers directly from the query" -> SELECT WHERE firstSeenAt < (NOW - 2h)
  let remaining = amountToDelete

  try {
    const { results: candidates } = await index.getDocuments({
      limit: remaining,
      filter: `firstSeenAt < ${twoHoursAgo}`,
      sort: ['count:asc', 'firstSeenAt:desc'],
      fields: ['key']
    })

    if (candidates.length > 0) {
      const ids = candidates.map(c => c.key)
      await index.deleteDocuments(ids)
      remaining -= ids.length
    }

    // 2. Force delete if needed (remove filtering out of newcomers)
    if (remaining > 0) {
      const { results: forced } = await index.getDocuments({
        limit: remaining,
        sort: ['count:asc', 'firstSeenAt:desc'],
        fields: ['key']
      })
      if (forced.length > 0) {
        const ids = forced.map(c => c.key)
        await index.deleteDocuments(ids)
      }
    }
  } catch (err) {
    console.error('Error during pruning:', err)
  }
}

export async function flushRequestedPubkeysToMDB () {
  if (requestedPubkeysCache.size === 0) return

  const currentCache = new Map(requestedPubkeysCache)
  requestedPubkeysCache.clear()

  const ops = []
  for (const [pubkey, hll] of currentCache.entries()) {
    const compressed = await compressAsync(hll.getRegisters())
    ops.push({
      type: 'mergeHll',
      data: { key: pubkey, hll: bytesToBase64(compressed) }
    })
  }

  // Update Estimates & Check Pruning
  pendingOpsCount += ops.length
  flushesSinceLastCheck++
  // We multiply by PROCESSES_COUNT because each process has it's own separate pendingOpsCount
  // We add 10% buffer to account for differences between pendingOpsCounts from different processes
  const estimatedCount = lastCachedCount + (pendingOpsCount * PROCESSES_COUNT * 1.1)

  const shouldCheck =
    // Check if we are over limit OR close to it (e.g. > 90%)
    (estimatedCount > MAX_DOCS * 0.9) ||
    // Check anyway if enough time has passed
    (flushesSinceLastCheck >= CHECK_INTERVAL)

  if (shouldCheck) {
    try {
      const stats = await mdb.index('requestedPubkeys').getStats()
      lastCachedCount = stats.numberOfDocuments
      pendingOpsCount = 0 // Reset estimated pending as we synced with real count
      flushesSinceLastCheck = 0

      if (lastCachedCount > MAX_DOCS) {
        console.log(`Pruning requestedPubkeys. Count: ${lastCachedCount}. Limit: ${MAX_DOCS}`)
        const toDelete = lastCachedCount - TARGET_DOCS
        await pruneRequestedPubkeys(toDelete)
        // Adjust cached count after prune
        lastCachedCount = Math.max(0, lastCachedCount - toDelete)
      }
    } catch (err) {
      const isNotFound = err.code === 'index_not_found' || err.cause?.code === 'index_not_found'
      // If index doesn't exist yet, getStats throws. Ignore.
      if (!isNotFound) {
        console.error('Failed to check/prune requestedPubkeys:', err)
      }
    }
  }

  await queueOps(ops)
}
