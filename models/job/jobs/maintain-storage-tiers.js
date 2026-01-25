import mdb from '#services/db/mdb.js'
import { loadPopularityFilters, getPopularityLevel, checkStorageLimitAndPrune, queueOps } from '#services/event/maintainer/mdb/index.js'
import { CuckooFilter, packFilter, unpackFilter } from '#helpers/cuckoo.js'

async function run () {
  console.log('Running storage tiers maintenance...')

  // 1. Get Reference Info (last calc job)
  let calcJob
  try {
    calcJob = await mdb.index('jobs').getDocument('calcPopularPubkeys')
  } catch (err) {
    if (err.code !== 'document_not_found' && err.cause?.code !== 'document_not_found') throw err
  }

  if (!calcJob || !calcJob.endedAt) {
    console.log('No calcPopularPubkeys run found. Skipping.')
    return
  }

  const referenceDesc = `calc-${calcJob.endedAt}`
  const stateKey = 'calcPopularPubkeys-current'

  // 2. Load or Create State
  let state
  try {
    state = await mdb.index('maintenanceState').getDocument(stateKey)

    if (state.createdAt !== calcJob.endedAt) {
      const err = new Error('Outdated state')
      err.code = 'document_not_found'
      throw err
    }

    state.levelUpdatedCuckooRaw = state.levelUpdatedCuckoo
      ? (await unpackFilter(state.levelUpdatedCuckoo)) || new CuckooFilter(100000, 4, 3)
      : new CuckooFilter(100000, 4, 3) // Large filter for processed PKs
    state.maintenanceDoneCuckooRaw = state.maintenanceDoneCuckoo
      ? (await unpackFilter(state.maintenanceDoneCuckoo)) || new CuckooFilter(100000, 4, 3)
      : new CuckooFilter(100000, 4, 3)
    state.eventsProcessedCuckooRaw = state.eventsProcessedCuckoo
      ? (await unpackFilter(state.eventsProcessedCuckoo)) || new CuckooFilter(1000000, 4, 3)
      : new CuckooFilter(1000000, 4, 3) // 1 Million events capacity
  } catch (err) {
    if (err.code === 'document_not_found' || err.cause?.code === 'document_not_found') {
      state = {
        key: stateKey,
        jobKey: 'calcPopularPubkeys',
        createdAt: calcJob.endedAt,
        levelUpdatedCuckooRaw: new CuckooFilter(100000, 4, 3),
        maintenanceDoneCuckooRaw: new CuckooFilter(100000, 4, 3),
        eventsProcessedCuckooRaw: new CuckooFilter(1000000, 4, 3)
      }
    } else {
      throw err
    }
  }

  await loadPopularityFilters()

  const BATCH_SIZE = 100
  let offset = 0
  let processed = 0
  // By setting a flag the first time a pubkey is not found in the cuckoo filter,
  // we can skip the filter check for all subsequent pubkeys (since the
  // processing order is sorted), effectively avoiding false positives
  // that would otherwise cause valid items to be skipped.
  let levelUpdateReachedUnprocessed = false
  let maintenanceReachedUnprocessed = false

  while (true) {
    // Iterate storedEventOwners where entityType='pubkey'
    const { results } = await mdb.index('storedEventOwners').getDocuments({
      offset,
      limit: BATCH_SIZE,
      filter: 'entityType = "pubkey"',
      sort: ['key:asc']
    })

    if (results.length === 0) break

    for (const ownerDoc of results) {
      const pubkey = ownerDoc.key
      let { popularityLevel } = ownerDoc

      // --- Step 2: Update Popularity Level (if not done) ---
      if (levelUpdateReachedUnprocessed || !state.levelUpdatedCuckooRaw.has(pubkey)) {
        levelUpdateReachedUnprocessed = true
        const newLevel = getPopularityLevel(pubkey)

        // Update DB if changed (or even if not, to sync fields?)
        // The requirement: "turn the current popularityLevel into the previousPopularityLevel field"
        // This implies we ALWAYS update if we haven't processed this step yet.
        await mdb.index('storedEventOwners').updateDocuments([{
          ...ownerDoc,
          previousPopularityLevel: popularityLevel,
          popularityLevel: newLevel
        }])

        // Update local vars for next step
        popularityLevel = newLevel

        state.levelUpdatedCuckooRaw.add(pubkey)
      }

      // --- Step 3: Maintenance (if not done) ---
      if (maintenanceReachedUnprocessed || !state.maintenanceDoneCuckooRaw.has(pubkey)) {
        maintenanceReachedUnprocessed = true
        // Check for Relegation
        if (popularityLevel > 5) {
          // Relegation Logic: Move 'pubkey' events to 'ip'
          await relegateEvents(pubkey, state, popularityLevel)
        } else {
          // Still popular (1-5)
          // Just prune
          const { ops } = await checkStorageLimitAndPrune({ pubkey, ip: null, newEventSize: 0, popularityLevel })
          await queueOps(ops)
        }

        state.maintenanceDoneCuckooRaw.add(pubkey)
      }
    }

    // Save State periodically
    await saveState(state)

    offset += BATCH_SIZE
    processed += results.length
    console.log(`Processed ${processed} owners...`)
  }

  // Cleanup old states? Optional.
  console.log(`Maintenance job done for ${referenceDesc}.`)
}

async function relegateEvents (pubkey, state, popularityLevel) {
  // Find events for this pubkey with ownerType='pubkey'
  // and switch them to ownerType='ip'
  // Also need to handle 'ip' usage update.

  const BATCH = 50
  let batchCount = 0
  let offset = 0

  while (true) {
    const filter = `pubkey = ${mdb.toMeiliValue(pubkey)} AND ownerType = "pubkey"`
    // Use sort and variable offset to ensure progress through the list
    const { hits: events } = await mdb.index('events').search('', {
      filter,
      limit: BATCH,
      offset,
      sort: ['created_at:asc']
    })

    if (events.length === 0) break

    // Filter out already processed events (due to Meilisearch async indexing lag or restart)
    const newEvents = events.filter(ev => {
      const primaryKey = ev.ref
      return !state.eventsProcessedCuckooRaw.has(primaryKey)
    })

    if (newEvents.length === 0) {
      // If found events are all in Cuckoo, they are either processed (index lag) or false positives.
      // We advance the offset to break potential infinite loops.
      offset += BATCH
      continue
    }

    // Group by IP to batch updates
    const eventsByIp = {}
    for (const ev of newEvents) {
      if (!ev.ip) continue // Should have IP
      if (!eventsByIp[ev.ip]) eventsByIp[ev.ip] = []
      eventsByIp[ev.ip].push(ev)
    }

    // ... Processing ...
    const allOps = []

    for (const [ip, ipEvents] of Object.entries(eventsByIp)) {
      // Update Usage for IP
      const sizeToAdd = ipEvents.reduce((acc, ev) => acc + (ev.byteSize || 0), 0)
      const { ops } = await checkStorageLimitAndPrune({ pubkey, ip, newEventSize: sizeToAdd, popularityLevel })

      // Queue event updates (changing ownerType to 'ip') atomically with usage update
      ipEvents.forEach(ev => {
        ops.push({
          type: 'patchDocumentIfExists',
          data: { index: 'events', document: { ref: ev.ref, ownerType: 'ip' } }
        })
      })

      allOps.push(...ops)
    }

    // Decrement usage for PK
    const totalBytesRemoved = newEvents.reduce((acc, ev) => acc + (ev.byteSize || 0), 0)
    if (totalBytesRemoved > 0) {
      allOps.push({
        type: 'deltaUsage',
        data: { targetKey: pubkey, delta: -totalBytesRemoved, entityType: 'pubkey' }
      })
    }

    // Flush all ops in one batch
    await queueOps(allOps)

    // Mark as processed only after successful queueing
    for (const ev of newEvents) {
      const primaryKey = ev.ref
      state.eventsProcessedCuckooRaw.add(primaryKey)
    }

    // Advance offset
    offset += BATCH

    // Periodically save state here too?
    // If we process many batches, we should save state so we don't lose the cuckoo filter additions.
    // Optimization: Only save every 10 batches to avoid excessive DB writes and waiting
    batchCount++
    if (batchCount % 10 === 0) {
      await saveState(state)
    }
  }
}

async function saveState (state) {
  await mdb.index('maintenanceState').updateDocuments([{
    key: state.key,
    jobKey: state.jobKey,
    createdAt: state.createdAt,
    levelUpdatedCuckoo: await packFilter(state.levelUpdatedCuckooRaw),
    maintenanceDoneCuckoo: await packFilter(state.maintenanceDoneCuckooRaw),
    eventsProcessedCuckoo: await packFilter(state.eventsProcessedCuckooRaw)
  }])
}

const config = {
  key: 'maintainStorageTiers',
  frequency: 60 * 60 * 24, // Not used
  manual: true, // Manual trigger only
  shouldUseLock: true,
  run
}

export default config
