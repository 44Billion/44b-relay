import { CountMinSketch } from 'bloom-filters'
import mdb from '#services/db/mdb.js'
import { pruneEvents, queueOps } from '#services/event/maintainer/mdb/index.js'

// Configuration for CountMinSketch
// epsilon: error rate (e.g. 0.001 = 0.1% error)
// delta: probability of error (e.g. 0.99 = 99% confidence)
export const CMS_EPSILON = 0.001
export const CMS_DELTA = 0.99

// Local cache
let localCMS = new CountMinSketch(CMS_EPSILON, CMS_DELTA)
const lastActiveAtSubmissions = new Map() // IP -> Timestamp

export function trackIpActivity ({ ip }) {
  if (!ip) return
  localCMS.update(ip)
  lastActiveAtSubmissions.set(ip, Date.now())
}

// ----------------------------------------------------------------------------
// Flush Logic (Queue Ops)
// ----------------------------------------------------------------------------

export async function flushIpActivityToMDB () {
  if (lastActiveAtSubmissions.size === 0) return

  // 1. Snapshot and Reset Local State
  const currentCMS = localCMS
  const currentActiveAts = new Map(lastActiveAtSubmissions)

  localCMS = new CountMinSketch(CMS_EPSILON, CMS_DELTA)
  lastActiveAtSubmissions.clear()

  // 2. Prepare Ops
  const ops = []

  // CMS Merge Op
  ops.push({
    targetKey: 'globalCms',
    type: 'mergeCms',
    data: { cms: currentCMS.saveAsJSON() }
  })

  // IP Activity Updates
  for (const [ip, ts] of currentActiveAts) {
    ops.push({
      targetKey: ip,
      type: 'patchDocumentIfExists',
      data: {
        index: 'storedEventOwners',
        document: { key: ip, entityType: 'ip', lastActiveAt: ts }
      }
    })
  }

  try {
    await queueOps(ops)
  } catch (err) {
    console.error('Failed to queue IP activity ops', err)
  }
}

// ----------------------------------------------------------------------------
// Cleanup Logic (Delete Stale IPs)
// ----------------------------------------------------------------------------

const ONE_DAY = 1000 * 60 * 60 * 24

export async function deleteStaleIps () {
  let globalCMS
  try {
    const doc = await mdb.index('ipActivity').getDocument('globalCms')
    globalCMS = CountMinSketch.fromJSON(JSON.parse(doc.json))
  } catch (err) {
    if (err.code === 'document_not_found') return // Nothing to clean
    console.error('deleteStaleIps: Failed to load global CMS', err)
    return
  }

  // Iterate over storedEventOwners where entityType = 'ip'
  // We can't easily filter by "lastActiveAt < X" because X depends on the IP's score.
  // So we iterate all IPs (or at least those that haven't been active very recently).
  // Optimization: filter `lastActiveAt < now - 3 days` (minimum retention).

  const minRetentionDays = 3
  const now = Date.now()
  const cutoff = now - (minRetentionDays * ONE_DAY)

  const BATCH_SIZE = 50
  let offset = 0
  let hasMore = true

  while (hasMore) {
    const { results } = await mdb.index('storedEventOwners').search('', {
      filter: [
        'entityType = "ip"',
        `lastActiveAt < ${cutoff}`
      ],
      limit: BATCH_SIZE,
      offset
    })

    if (results.length === 0) {
      hasMore = false
      break
    }

    // We don't increase offset because we delete items, shifting the pagination?
    // Wait, `storedEventOwners` are DELETED at the end of correct processing.
    // If we skip deleting one, we must increase offset?
    // To be safe against infinite loops on non-deleted items:
    // We collect IDs to delete or skip.
    // Actually, `pruneEvents` deletes events, but we also need to delete the `storedEventOwner` record itself if it's stale.

    let deletedCount = 0

    for (const owner of results) {
      const ip = owner.key
      // If lastActiveAt is missing, treat as very old
      const lastActive = owner.lastActiveAt || 0
      const score = globalCMS.count(ip)

      // Calculate Retention based on Score (Activity)
      const retentionDays = calculateRetentionDays(score)
      const expirationTime = lastActive + (retentionDays * ONE_DAY)

      if (now > expirationTime) {
        // STALE!
        // 1. Prune/Promote Events
        // This will promote popular events to 'pubkey' ownerType and delete the rest.
        await pruneEvents({
          ownerKey: ip,
          ownerType: 'ip',
          bytesToRemove: Number.MAX_SAFE_INTEGER // Remove everything belonging to this IP
        })

        // 2. Delete the Owner Record
        await mdb.index('storedEventOwners').deleteDocuments([ip])
        deletedCount++
      } else {
        // Not stale yet (high score saved it)
        // We'll see it again next time, or we skip it now.
      }
    }

    // If we didn't delete anything in this batch, we must advance offset to avoid loop
    if (deletedCount === 0) {
      offset += results.length
    } else {
      // If we deleted some, the next page has shifted.
      // safest is to keep offset 0 if we assume we are draining the pool of "potential candidates".
      // But we are searching `lastActiveAt < cutoff`.
      // The items we merely skipped are still explicitly returned by that query.
      // So effectively we need to track which ones we processed/skipped to avoid rescanning them in this exact run,
      // OR we just assume `offset += (results.length - deletedCount)`?
      // If I delete 10 out of 50. The indices 0-9 are gone. 10-49 shift to 0-39.
      // So I should have skipped the *remaining* 40.
      offset += (results.length - deletedCount)
    }
  }
}

function calculateRetentionDays (score) {
  // Configurable Policy:
  // Score 0-10: 3 days
  // Score 10-100: 7 days
  // Score 100-1000: 30 days
  // Score 1000+: 90 days

  // Using a logarithmic scale or steps
  if (score < 10) return 3
  if (score < 100) return 7
  if (score < 1000) return 30
  return 90
}
