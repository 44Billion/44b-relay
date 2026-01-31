import { Buffer } from 'buffer'
import { ConservativeCountMin } from 'sketch-oxide-node'
import mdb from '#services/db/mdb.js'
import { pruneEvents, queueOps } from '#services/event/maintainer/mdb/index.js'
import { ipToPrimaryKey, primaryKeyToIp } from '#helpers/mdb.js'
import { compressAsync, decompressAsync } from '#helpers/buffer.js'

// Configuration for CountMinSketch
// epsilon: error rate (e.g. 0.001 = 0.1% error)
// delta: probability of error (e.g. 0.99 = 99% confidence)
export const SKETCH_EPSILON = 0.001
export const SKETCH_DELTA = 0.99
export const WINDOW_DURATION = 1000 * 60 * 60 * 24 // 24 Hours

export function createSketch () {
  return new ConservativeCountMin(SKETCH_EPSILON, 1 - SKETCH_DELTA)
}

// Local cache
let localSketch = createSketch()
const lastActiveAtSubmissions = new Map() // IP -> Timestamp

// Global Cache (Read-Only for Spam Detection)
let cachedGlobalCurrent = createSketch()
let cachedGlobalPrevious = createSketch()
let lastCacheUpdate = 0
let isFetchingCache = false
const CACHE_TTL = 1000 * 60 * 15 // 15 Minutes

export function trackIpActivity ({ ip }) {
  if (!ip) return
  localSketch.update(Buffer.from(ip))
  lastActiveAtSubmissions.set(ip, Date.now())
}

export function getIpScore (ip) {
  if (!ip) return 0

  // Lazy Refresh
  if (!isFetchingCache && Date.now() - lastCacheUpdate > CACHE_TTL) {
    isFetchingCache = true
    refreshGlobalSketches().finally(() => { isFetchingCache = false })
  }

  const buf = Buffer.from(ip)
  // Total = Local (Real-time Pending) + Global Current (Synced) + Global Previous (Rolling Window)
  return localSketch.estimate(buf) + cachedGlobalCurrent.estimate(buf) + cachedGlobalPrevious.estimate(buf)
}

async function refreshGlobalSketches () {
  try {
    const [docCurr, docPrev] = await Promise.all([
      mdb.index('ipActivities').getDocument('sketch-current').catch(() => null),
      mdb.index('ipActivities').getDocument('sketch-previous').catch(() => null)
    ])

    if (docCurr) cachedGlobalCurrent = ConservativeCountMin.deserialize(await decompressAsync(Buffer.from(docCurr.data, 'base64url')))
    if (docPrev) cachedGlobalPrevious = ConservativeCountMin.deserialize(await decompressAsync(Buffer.from(docPrev.data, 'base64url')))

    lastCacheUpdate = Date.now()
  } catch (err) {
    console.error('Failed to refresh global IP sketches', err)
  }
}
// ----------------------------------------------------------------------------
// Flush Logic (Queue Ops)
// ----------------------------------------------------------------------------

export async function flushIpActivityToMDB () {
  if (lastActiveAtSubmissions.size === 0) return

  // 1. Snapshot and Reset Local State
  const currentSketch = localSketch
  const currentActiveAts = new Map(lastActiveAtSubmissions)

  localSketch = createSketch()
  lastActiveAtSubmissions.clear()

  // 2. Prepare Ops
  const ops = []

  // Sketch Merge Op
  const compressedSketch = await compressAsync(currentSketch.serialize())
  ops.push({
    type: 'mergeSketch',
    data: { targetKey: 'sketch-current', sketch: compressedSketch.toString('base64url') }
  })

  // IP Activity Updates
  for (const [ip, ts] of currentActiveAts) {
    ops.push({
      type: 'patchDocumentIfExists',
      data: {
        index: 'storedEventOwners',
        document: { key: ipToPrimaryKey(ip), entityType: 'ip', lastActiveAt: ts }
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
  let sketchCurrent, sketchPrevious

  try {
    const [docCurr, docPrev, docMeta] = await Promise.all([
      mdb.index('ipActivities').getDocument('sketch-current').catch(() => null),
      mdb.index('ipActivities').getDocument('sketch-previous').catch(() => null),
      mdb.index('ipActivities').getDocument('sketch-meta').catch(() => ({ lastRotation: 0 }))
    ])

    sketchCurrent = docCurr
      ? ConservativeCountMin.deserialize(await decompressAsync(Buffer.from(docCurr.data, 'base64url')))
      : createSketch()

    sketchPrevious = docPrev
      ? ConservativeCountMin.deserialize(await decompressAsync(Buffer.from(docPrev.data, 'base64url')))
      : createSketch()

    // Rotation Logic (Sliding Window)
    // If we passed WINDOW_DURATION, we shift:
    // Previous <- Current
    // Current <- New Empty
    const lastRotation = docMeta.lastRotation || 0
    const now = Date.now()

    if (now - lastRotation > WINDOW_DURATION) {
      console.log('Rotating IP Activity Sketch Window')
      const prevSerialized = (await compressAsync(sketchCurrent.serialize())).toString('base64url')
      const newSerialized = (await compressAsync(createSketch().serialize())).toString('base64url')

      // Apply rotation to DB
      await Promise.all([
        mdb.index('ipActivities').addDocuments([{ key: 'sketch-previous', data: prevSerialized }]),
        mdb.index('ipActivities').addDocuments([{ key: 'sketch-current', data: newSerialized }]),
        mdb.index('ipActivities').addDocuments([{ key: 'sketch-meta', lastRotation: now }])
      ])

      // Update local in-memory reference
      sketchPrevious = sketchCurrent
      sketchCurrent = createSketch()
    }
  } catch (err) {
    if (err.code === 'document_not_found' || err.cause?.code === 'document_not_found') return // Nothing to clean
    console.error('deleteStaleIps: Failed to load Sketch state', err)
    return
  }

  // Iterate over storedEventOwners where entityType = 'ip'
  // Optimization: filter `lastActiveAt < now - 3 days` (minimum retention).

  const minRetentionDays = 3
  const now = Date.now()
  const cutoff = now - (minRetentionDays * ONE_DAY)

  const BATCH_SIZE = 50
  let offset = 0
  let hasMore = true

  while (hasMore) {
    const { results } = await mdb.index('storedEventOwners').getDocuments({
      filter: ['entityType = "ip"', `lastActiveAt < ${cutoff}`],
      limit: BATCH_SIZE,
      offset
    })

    if (results.length === 0) {
      hasMore = false
      break
    }

    let deletedCount = 0

    for (const owner of results) {
      const encodedIp = owner.key
      // storedEventOwners keys are base64 encoded IPs (or similar).
      // We need the raw IP string to query the CMS.
      const ip = primaryKeyToIp(encodedIp)
      const lastActive = owner.lastActiveAt || 0

      // SLIDING WINDOW SCORE
      // Sum of Current + Previous
      const ipBuf = Buffer.from(ip)
      const currentScore = sketchCurrent.estimate(ipBuf)
      const prevScore = sketchPrevious.estimate(ipBuf)
      const score = currentScore + prevScore

      // console.log(`DEBUG: IP ${ip} Score: ${score} (Curr: ${currentScore}, Prev: ${prevScore})`)

      // Calculate Retention based on Score (Activity)
      const retentionDays = calculateRetentionDays(score)
      const expirationTime = lastActive + (retentionDays * ONE_DAY)

      if (now > expirationTime) {
        // Stale!
        // 1. Prune events owned by this IP
        // This will promote popular events to 'pubkey' ownerType and delete the rest
        await pruneEvents({
          ownerKey: encodedIp,
          ownerType: 'ip',
          bytesToRemove: Number.MAX_SAFE_INTEGER
        })

        // 2. Delete the IP record itself
        await mdb.index('storedEventOwners').deleteDocuments([encodedIp])
        deletedCount++
      }
    }

    // Pagination logic
    if (deletedCount === 0) {
      offset += results.length
    } else {
      offset += (results.length - deletedCount)
    }
  }
}

function calculateRetentionDays (score) {
  // Score represents activity (Events published + Subscriptions opened)
  // over the last ~24-48 hours (Current + Previous Daily Windows).
  //
  // Policy:
  // Score 0-10: 3 days (Transient/Low activity - e.g. < 5 actions/day)
  // Score 10-100: 7 days (Moderate activity - e.g. casual user)
  // Score 100-1000: 30 days (High activity - e.g. power user/relay enthusiast)
  // Score 1000+: 90 days (Very high activity - e.g. bridge/bot/heavy user)

  // Using a logarithmic scale or steps
  if (score < 10) return 3
  if (score < 100) return 7
  if (score < 1000) return 30
  return 90
}
