import mdb from '#services/db/mdb.js'
import { FastBloomFilter, packFilter } from '#helpers/bloom.js'
import requestedPubkeySchema from '#models/requested-pubkey/schema.js'
import { base16ToBytes } from '#helpers/base16.js'

async function snapshotAndResetLiveIndex (
  liveUid,
  stagingUid
) {
  try {
    let liveStats, stagingStats
    try {
      liveStats = await mdb.index(liveUid).getStats()
    } catch (_err) {
      throw new Error('Live index does not exist yet. Nothing to snapshot.')
    }

    try {
      stagingStats = await mdb.index(stagingUid).getStats()
    } catch (_err) {
      stagingStats = null // Staging index doesn't exist yet
    }

    if (stagingStats) {
      console.log(`Snapshot '${stagingUid}' already exists, skipping cloning step.`)

      if (
        liveStats.numberOfDocuments === 0 ||
        stagingStats.numberOfDocuments >= liveStats.numberOfDocuments
      ) {
        console.warn('Live index is already empty and snapshot is full. Skipping reset.')
        // eslint-disable-next-line no-useless-return
        return
      }
    } else {
      console.log(`Creating ${stagingUid} and swapping with ${liveUid}...`)
      // Ensure proper schema
      await mdb.createIndex(stagingUid, { primaryKey: requestedPubkeySchema.primaryKey })
      await mdb.index(stagingUid).updateSettings(requestedPubkeySchema.settings)

      // Swap atomically: Live(Data) <-> Staging(Empty)
      // Result: Live(Empty), Staging(Data)
      await mdb.swapIndexes([{ indexes: [liveUid, stagingUid] }])
      console.log(`Swap complete. ${liveUid} is now empty.`)
    }
  } catch (error) {
    if (error.code === 'index_not_found') {
      console.log('Live index not found, nothing to snapshot.')
      return
    }
    console.error('Operation failed:', error.stack)
  }
}

export async function run () {
  console.log('Running daily popular pubkeys calculation...')

  const liveUid = 'requestedPubkeys' // live index
  const stagingUid = 'metricsStagingRequestedPubkeys' // maintenance index
  await snapshotAndResetLiveIndex(liveUid, stagingUid)

  // 1. Calculate Thresholds based on Total Count
  // We use simple stats to get the total number of docs.
  let totalPubkeys = 0
  try {
    const stats = await mdb.index(stagingUid).getStats()
    totalPubkeys = stats.numberOfDocuments
  } catch (_e) {
    console.log('Staging index stats failed, assuming 0')
    return
  }

  if (totalPubkeys === 0) {
    console.log('No requested pubkeys found.')
    return
  }

  // Define Thresholds
  const thresholds = [
    { level: 1, limit: Math.ceil(totalPubkeys * 0.0001) },
    { level: 2, limit: Math.ceil(totalPubkeys * 0.01) },
    { level: 3, limit: Math.ceil(totalPubkeys * 0.03) },
    { level: 4, limit: Math.ceil(totalPubkeys * 0.05) },
    { level: 5, limit: Math.ceil(totalPubkeys * 0.10) },
    { level: 6, limit: Math.ceil(totalPubkeys * 0.50) }
  ]
  const maxLimit = thresholds[5].limit

  // 2. Stream & Process Pubkeys (Sorted by count:desc)
  // We will iterate through the sorted list until we reach the max limit (Level 6).
  // Everything else is discarded.

  const filters = {}
  // Initialize filters with estimated sizes
  // To avoid resizing we set capacity = diff between limit of this level and previous level
  let prevLimit = 0
  for (const t of thresholds) {
    const size = Math.max(t.limit - prevLimit, 100)
    filters[t.level] = await FastBloomFilter.createOptimal(size, 0.0001)
    prevLimit = t.limit
  }

  let offset = 0
  const limit = 1000 // Batch size
  let processedCount = 0

  while (processedCount < maxLimit) {
    const { results } = await mdb.index(stagingUid).getDocuments({
      offset,
      limit,
      sort: ['count:desc']
    })

    if (results.length === 0) break

    for (const doc of results) {
      processedCount++
      const rank = processedCount

      // Determine Level
      // Since filters are strictly exclusive ranges in our logic:
      // Level 1: 1 .. L1
      // Level 2: L1+1 .. L2
      // ...

      for (const t of thresholds) {
        if (rank <= t.limit) {
          // Add to the highest priority level matches this rank.
          // Since thresholds are sorted by limit (L1 < L2 < ...), the first match is the correct exclusive range.
          // e.g. Rank 5 fits in L1 (limit 10). Rank 15 misses L1 but fits in L2 (limit 100).
          filters[t.level].add(base16ToBytes(doc.key))
          break
        }
      }

      if (processedCount >= maxLimit) break
    }

    offset += limit
  }

  // 4. Create/Update Bloom docs
  const docsToSave = []

  // Fetch all old docs first to map the transitions
  const oldDocs = {}
  const maxLevels = thresholds.length
  try {
    const { hits: results } = await mdb.index('popularPubkeys').search('', { limit: maxLevels })
    results.forEach(doc => { oldDocs[doc.key] = doc })
  } catch (_e) {}

  for (let level = 1; level <= maxLevels; level++) {
    const filter = filters[level]
    const packedFilter = await packFilter(filter)

    // Determine Relegated Filter (Old Normal of PREVIOUS level)
    let relegatedFilter = null
    if (level > 1) {
      const prevLevelDoc = oldDocs[String(level - 1)]
      if (prevLevelDoc && prevLevelDoc.filter) {
        relegatedFilter = prevLevelDoc.filter
      }
    }

    docsToSave.push({
      key: String(level),
      filter: packedFilter,
      relegatedFilter
    })
  }

  await mdb.index('popularPubkeys').addDocuments(docsToSave)

  // 5. Reset metricsStagingRequestedPubkeys
  await mdb.index(stagingUid).delete()

  console.log('Daily calculation done.', {
    total: totalPubkeys
  })

  // 6. Trigger Maintenance Job
  console.log('Triggering maintainStorageTiers...')
  const now = Math.floor(Date.now() / 1000)
  try {
    // We update the maintenance job record to request a run.
    // Setting requestedAt > endedAt will signal the worker to start it.
    await mdb.index('jobs').updateDocuments([{
      key: 'maintainStorageTiers',
      requestedAt: now
    }])
  } catch (err) {
    console.error('Failed to trigger maintainStorageTiers:', err)
  }
}

const config = {
  key: 'calcPopularPubkeys',
  frequency: 86400, // Daily
  shouldUseLock: true,
  run
}

export default config
