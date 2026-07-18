import { Buffer } from 'node:buffer'
import mdb from '#services/db/mdb.js'
import { MANIFEST_KINDS } from '#constants/event.js'
import { loadAndMaybeRotateSketches } from '#services/event/tracker/mdb/requested-events.js'
import {
  getManifestPoolUsage,
  MANIFEST_POOL_LIMITS,
  reconcileManifestPoolUsage,
  recoverManifestReservations
} from '#services/event/manifest-pool.js'
import { queueDeleteEventsWithAccounting } from '#services/event/pending-workflows.js'

const BATCH_SIZE = 250
const RECONCILE_INTERVAL_SECONDS = 60 * 60
const KIND_FILTER = [...MANIFEST_KINDS].map(kind => `kind = ${kind}`).join(' OR ')

function requestScore (ref, sketches) {
  const value = Buffer.from(ref)
  return sketches.sketchCurrent.estimate(value) + sketches.sketchPrevious.estimate(value)
}

// The first pass stores only one byte total per distinct request score. The
// second pass asks Meilisearch for the tie-break ordering and never retains the
// whole subsidized pool in memory.
export function findBoundaryScore (bytesByScore, bytesToRemove) {
  let bytesBelow = 0
  for (const [score, bytes] of [...bytesByScore.entries()].sort((a, b) => a[0] - b[0])) {
    if (bytesBelow + bytes >= bytesToRemove) {
      return { score, bytesNeededAtBoundary: Math.max(0, bytesToRemove - bytesBelow) }
    }
    bytesBelow += bytes
  }
  return { score: Infinity, bytesNeededAtBoundary: Infinity }
}

async function scanEvents (filter, options, visit) {
  let offset = 0
  while (true) {
    const { results } = await mdb.index('events').getDocuments({
      filter,
      fields: ['ref', 'id', 'kind', 'pubkey', 'byteSize', 'receivedAt', 'ownerType', 'ip'],
      limit: BATCH_SIZE,
      offset,
      ...options
    })
    if (!results.length) break
    const removed = await visit(results)
    if (results.length < BATCH_SIZE) break
    // A deletion shrinks the result set. Advancing only past retained records
    // prevents either skipping or revisiting documents.
    offset += results.length - (removed || 0)
  }
}

async function pruneFilter ({ filter, bytesToRemove, sketches }) {
  if (bytesToRemove <= 0) return { bytesRemoved: 0, manifestsRemoved: 0 }

  const bytesByScore = new Map()
  await scanEvents(filter, {}, async results => {
    for (const event of results) {
      const score = requestScore(event.ref, sketches)
      bytesByScore.set(score, (bytesByScore.get(score) || 0) + (event.byteSize || 0))
    }
    return 0
  })

  const boundary = findBoundaryScore(bytesByScore, bytesToRemove)
  let boundaryBytes = 0
  let bytesRemoved = 0
  let manifestsRemoved = 0

  await scanEvents(filter, {
    sort: ['receivedAt:asc', 'byteSize:desc', 'ref:asc']
  }, async results => {
    const selected = []
    for (const event of results) {
      const score = requestScore(event.ref, sketches)
      const belowBoundary = score < boundary.score
      const atNeededBoundary = score === boundary.score && boundaryBytes < boundary.bytesNeededAtBoundary
      if (!belowBoundary && !atNeededBoundary) continue
      selected.push(event)
      if (score === boundary.score) boundaryBytes += event.byteSize || 0
    }

    if (selected.length) {
      await queueDeleteEventsWithAccounting(selected, {
        pruning: true,
        source: 'pruneManifestPool'
      })
      bytesRemoved += selected.reduce((sum, event) => sum + (event.byteSize || 0), 0)
      manifestsRemoved += selected.length
    }
    // Deletion is asynchronous, so the result set has not shrunk yet.
    return 0
  })

  return { bytesRemoved, manifestsRemoved }
}

export async function pruneManifestPool () {
  await recoverManifestReservations()
  let usage = await getManifestPoolUsage()
  const now = Math.floor(Date.now() / 1000)
  if (!usage.global.reconciledAt || now - usage.global.reconciledAt >= RECONCILE_INTERVAL_SECONDS) {
    usage = await reconcileManifestPoolUsage()
  }

  const sketches = await loadAndMaybeRotateSketches()
  let bytesRemoved = 0
  let manifestsRemoved = 0
  let scheduledAuthorPruning = false

  // Correct abusive authors first. This also reduces the global pool before
  // its own target is evaluated.
  for (const author of usage.authors) {
    if (author.logicalBytes <= MANIFEST_POOL_LIMITS.author.nominal) continue
    const result = await pruneFilter({
      filter: `(${KIND_FILTER}) AND pubkey = ${mdb.toMeiliValue(author.pubkey)}`,
      bytesToRemove: author.logicalBytes - MANIFEST_POOL_LIMITS.author.target,
      sketches
    })
    bytesRemoved += result.bytesRemoved
    manifestsRemoved += result.manifestsRemoved
    scheduledAuthorPruning ||= result.manifestsRemoved > 0
  }

  // Let author-quota deletions settle before calculating the global deficit;
  // otherwise the same still-visible manifest could be selected twice in one
  // run. The five-minute follow-up handles the global pool if still needed.
  usage = await getManifestPoolUsage()
  if (!scheduledAuthorPruning && usage.global.logicalBytes > MANIFEST_POOL_LIMITS.global.nominal) {
    const result = await pruneFilter({
      filter: `(${KIND_FILTER})`,
      bytesToRemove: usage.global.logicalBytes - MANIFEST_POOL_LIMITS.global.target,
      sketches
    })
    bytesRemoved += result.bytesRemoved
    manifestsRemoved += result.manifestsRemoved
  }

  const finalUsage = await getManifestPoolUsage()
  console.log('Manifest pool capacity pruning', {
    logicalBytes: finalUsage.global.logicalBytes,
    manifestCount: finalUsage.global.manifestCount,
    bytesScheduled: bytesRemoved,
    manifestsScheduled: manifestsRemoved,
    pruningCount: finalUsage.global.pruningCount,
    rejectionCount: finalUsage.global.rejectionCount,
    usedDatabaseSize: finalUsage.global.usedDatabaseSize ?? null
  })
  return {
    bytesScheduled: bytesRemoved,
    manifestsScheduled: manifestsRemoved,
    // Keep aliases for callers of the existing internal API during rollout.
    bytesRemoved,
    manifestsRemoved,
    usage: finalUsage
  }
}

export async function run () {
  console.log('Running pruneManifestPool job...')
  await pruneManifestPool()
  console.log('Done pruneManifestPool job.')
}

export default {
  key: 'pruneManifestPool',
  frequency: 60 * 5,
  initialDelay: 3,
  shouldUseLock: true,
  run
}
