import mdb from '#services/db/mdb.js'
import { RELAY_OWNED_KINDS } from '#constants/event.js'
import { loadPopularityFilters, getPopularityLevel, checkStorageLimitAndPrune, queueOps, VIP_PUBKEYS } from '#services/event/maintainer/mdb/index.js'
import { FastBloomFilter, packFilter, unpackFilter } from '#helpers/bloom.js'
import { base16ToBytes } from '#helpers/base16.js'
import { PENDING_OPS_REVERSE_SORT } from '#models/pending-op/order.js'

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
    state = await mdb.index('maintenanceStates').getDocument(stateKey)

    if (state.createdAt !== calcJob.endedAt) {
      const err = new Error('Outdated state')
      err.code = 'document_not_found'
      throw err
    }

    state.levelUpdatedFilterRaw = state.levelUpdatedFilter
      ? (await unpackFilter(state.levelUpdatedFilter)) || await FastBloomFilter.createOptimal(100000, 0.0001)
      : await FastBloomFilter.createOptimal(100000, 0.0001) // Large filter for processed PKs
    state.maintenanceDoneFilterRaw = state.maintenanceDoneFilter
      ? (await unpackFilter(state.maintenanceDoneFilter)) || await FastBloomFilter.createOptimal(100000, 0.0001)
      : await FastBloomFilter.createOptimal(100000, 0.0001)
  } catch (err) {
    if (err.code === 'document_not_found' || err.cause?.code === 'document_not_found') {
      state = {
        key: stateKey,
        jobKey: 'calcPopularPubkeys',
        createdAt: calcJob.endedAt,
        levelUpdatedFilterRaw: await FastBloomFilter.createOptimal(100000, 0.0001),
        maintenanceDoneFilterRaw: await FastBloomFilter.createOptimal(100000, 0.0001)
      }
    } else {
      throw err
    }
  }

  // Check for previous pending ops from this job type
  let lastOp
  try {
    const { hits } = await mdb.index('pendingOps').search('', {
      filter: 'source = "maintainStorageTiers"',
      sort: PENDING_OPS_REVERSE_SORT,
      limit: 1
    })
    if (hits.length > 0) {
      lastOp = hits[0]
    }
  } catch (_e) {
    // ignore
  }

  if (lastOp) {
    console.log(`Waiting for previous ops to complete (last op: ${lastOp.key})...`)
    while (true) {
      try {
        await mdb.index('pendingOps').getDocument(lastOp.key)
        // If found, it means it's still pending
        await new Promise(resolve => setTimeout(resolve, 5000))
      } catch (err) {
        if (err.code === 'document_not_found' || err.cause?.code === 'document_not_found') {
          break // Op is gone, we can proceed
        }
        throw err
      }
    }
    console.log('Previous ops completed.')
  }

  await loadPopularityFilters()

  const BATCH_SIZE = 100
  let offset = 0
  let processed = 0
  // By setting a flag the first time a pubkey is not found in the filter,
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
      if (levelUpdateReachedUnprocessed || !state.levelUpdatedFilterRaw.has(base16ToBytes(pubkey))) {
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

        state.levelUpdatedFilterRaw.add(base16ToBytes(pubkey))
      }

      // --- Step 3: Maintenance (if not done) ---
      if (maintenanceReachedUnprocessed || !state.maintenanceDoneFilterRaw.has(base16ToBytes(pubkey))) {
        maintenanceReachedUnprocessed = true
        // Check for Relegation
        if (VIP_PUBKEYS.has(pubkey)) {
          // VIP pubkeys are exempt from relegation and pruning
        } else if (popularityLevel > 5) {
          // Relegation Logic: Move 'pubkey' events to 'ip'
          await relegateEvents(pubkey, state, popularityLevel)
        } else {
          // Still popular (1-5)
          // Just prune
          const { ops } = await checkStorageLimitAndPrune({ pubkey, ip: null, newEventSize: 0, popularityLevel })
          await queueOps(ops)
        }

        state.maintenanceDoneFilterRaw.add(base16ToBytes(pubkey))
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
    const relayOwnedExclusion = [...RELAY_OWNED_KINDS].map(kind => `kind != ${kind}`).join(' AND ')
    const filter = `pubkey = ${mdb.toMeiliValue(pubkey)} AND ownerType = "pubkey" AND ${relayOwnedExclusion}`
    // Use sort and variable offset to ensure progress through the list
    const { results: events } = await mdb.index('events').getDocuments({
      filter,
      limit: BATCH,
      offset,
      sort: ['created_at:asc']
    })

    if (events.length === 0) break

    // Group by IP to batch updates
    const eventsByIp = {}
    for (const ev of events) {
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
    const totalBytesRemoved = events.reduce((acc, ev) => acc + (ev.byteSize || 0), 0)
    if (totalBytesRemoved > 0) {
      allOps.push({
        type: 'deltaUsage',
        data: { key: pubkey, delta: -totalBytesRemoved, entityType: 'pubkey' }
      })
    }

    allOps.forEach(op => { op.source = 'maintainStorageTiers' })

    // Flush all ops in one batch
    await queueOps(allOps)

    // Advance offset
    offset += BATCH

    // Periodically save state here too?
    // If we process many batches, we should save state so we don't lose the filter additions.
    // Optimization: Only save every 10 batches to avoid excessive DB writes and waiting
    batchCount++
    if (batchCount % 10 === 0) {
      await saveState(state)
    }
  }
}

async function saveState (state) {
  await mdb.index('maintenanceStates').updateDocuments([{
    key: state.key,
    jobKey: state.jobKey,
    createdAt: state.createdAt,
    levelUpdatedFilter: await packFilter(state.levelUpdatedFilterRaw),
    maintenanceDoneFilter: await packFilter(state.maintenanceDoneFilterRaw)
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
