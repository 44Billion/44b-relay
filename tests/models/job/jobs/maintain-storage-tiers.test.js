import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import { processBatch, loadSystemState } from '#models/job/jobs/process-pending-ops/index.js'
import * as maintainStorageTiersJob from '#models/job/jobs/maintain-storage-tiers.js'
import { VIP_PUBKEYS } from '#services/event/maintainer/mdb/index.js'
import { FastBloomFilter, packFilter } from '#helpers/bloom.js'
import { base16ToBytes } from 'libp2r2p/base16'

const runPendingOps = async () => {
  const { hits } = await mdb.index('pendingOps').search('', { limit: 1000, sort: ['createdAt:asc', 'batchId:asc', 'position:asc', 'key:asc'] })
  const state = await loadSystemState()
  await processBatch(hits, state)
}

describe('Job: Maintain Storage Tiers', () => {
  beforeEach(async () => {
    await Promise.all([
      mdb.index('jobs').deleteAllDocuments(),
      mdb.index('maintenanceStates').deleteAllDocuments(),
      mdb.index('storedEventOwners').deleteAllDocuments(),
      mdb.index('events').deleteAllDocuments(),
      mdb.index('popularPubkeys').deleteAllDocuments(),
      mdb.index('pendingOps').deleteAllDocuments()
    ])
  })

  it('should require calcPopularPubkeys job to have run', async () => {
    // No jobs doc
    await maintainStorageTiersJob.default.run()

    // Should not create maintenanceState
    try {
      await mdb.index('maintenanceStates').getDocuments() // returns empty list usually
      // If it throws on empty, catch.
      // But getDocument would throw.
    } catch (_err) {}

    // We can verify by ensuring validation logic returned early.
    // If it ran, it would log or create state.
    // Let's assume if maintenanceState is empty, it didn't run.
    const { results } = await mdb.index('maintenanceStates').getDocuments()
    assert.equal(results.length, 0)
  })

  it('should run maintenance loop and update popularity', async () => {
    // 1. Setup Jobs
    await mdb.index('jobs').addDocuments([{ key: 'calcPopularPubkeys', endedAt: 123456 }])

    // 2. Setup Popular Pubkeys (Level 1 has 'pubkey1')
    const pubkey1 = '0000000000000000000000000000000000000000000000000000000000000001'
    const filter = await FastBloomFilter.createOptimal(100, 0.01)
    filter.add(base16ToBytes(pubkey1))
    await mdb.index('popularPubkeys').addDocuments([{
      key: '1',
      filter: await packFilter(filter)
    }])

    // 3. Setup Stored Event Owner
    // Initially popularityLevel 5. Should become 1.
    await mdb.index('storedEventOwners').addDocuments([{
      key: pubkey1,
      entityType: 'pubkey',
      popularityLevel: 5,
      usedBytes: 100
    }])

    // Wait
    await new Promise(resolve => setTimeout(resolve, 100))

    // Run
    await maintainStorageTiersJob.default.run()
    await runPendingOps()

    await new Promise(resolve => setTimeout(resolve, 100))

    // Assert
    // storedEventOwner should be updated to Level 1
    const owner = await mdb.index('storedEventOwners').getDocument(pubkey1)
    assert.equal(owner.popularityLevel, 1)

    // maintenanceState should exist
    const { results } = await mdb.index('maintenanceStates').getDocuments()
    assert.ok(results.length > 0)
  })

  it('should wait for previous unfinished maintainStorageTiers ops', async () => {
    // 1. Setup Jobs (prerequisite)
    await mdb.index('jobs').addDocuments([{ key: 'calcPopularPubkeys', endedAt: 123456 }])

    // 2. Insert a pending op from 'maintainStorageTiers'
    const opKey = 'previous-op-1'
    await mdb.index('pendingOps').addDocuments([{
      key: opKey,
      type: 'test-op',
      data: {},
      createdAt: Date.now(),
      source: 'maintainStorageTiers'
    }])

    let jobFinished = false
    const jobPromise = maintainStorageTiersJob.default.run().then(() => { jobFinished = true })

    // Wait a bit to ensure it reached the check loop
    await new Promise(resolve => setTimeout(resolve, 500))

    // Should still be waiting
    assert.equal(jobFinished, false, 'Job should be waiting for previous op to clear')

    // 3. Delete the op
    await mdb.index('pendingOps').deleteDocument(opKey)

    // Wait for the job to notice (it polls every 5s)
    // We just await the promise
    await jobPromise
    assert.equal(jobFinished, true, 'Job should complete after op is cleared')
  })

  it('should verify tagged source on new pending ops', async () => {
    // 1. Setup Jobs
    await mdb.index('jobs').addDocuments([{ key: 'calcPopularPubkeys', endedAt: 123456 }])

    // 2. Setup Stored Event Owner & Event to trigger relegation (which creates pending ops)
    const relegatedPubKeyHex = '0000000000000000000000000000000000000000000000000000000000DEAD01'
    await mdb.index('storedEventOwners').addDocuments([{
      key: relegatedPubKeyHex,
      entityType: 'pubkey',
      popularityLevel: 5,
      usedBytes: 100
    }])
    await mdb.index('events').addDocuments([{
      ref: 'ev1',
      pubkey: relegatedPubKeyHex,
      ip: '1.2.3.4',
      byteSize: 100,
      ownerType: 'pubkey',
      kind: 1, created_at: 100, tags: [], content: '', sig: ''
    }])

    await new Promise(resolve => setTimeout(resolve, 100))

    // Run job
    await maintainStorageTiersJob.default.run()

    // Check pendingOps for 'source' before processing them
    const { hits } = await mdb.index('pendingOps').search('')
    assert.ok(hits.length > 0)
    const tierOps = hits.filter(op => op.source === 'maintainStorageTiers')
    assert.ok(tierOps.length > 0, 'Should have ops with source=maintainStorageTiers')

    // Cleanup
    await runPendingOps()
  })

  it('should handle relegation when popularity > 5', async () => {
    // 1. Setup Jobs
    await mdb.index('jobs').addDocuments([{ key: 'calcPopularPubkeys', endedAt: 123456 }])

    // 2. Setup Popular Pubkeys (Empty -> everything is > 5) (Level 1..6 empty)
    // Actually if we don't return anything for loadPopularityFilters, it might keep default?
    // The service caches filters. Checks if updated recently.
    // If we want to ensure 'relegatedPubKey' is NOT in any filter -> level 999.

    // 3. Setup Stored Event Owner
    // Level 6 (or just not found in levels 1-5, so > 5)
    const relegatedPubKeyHex = '0000000000000000000000000000000000000000000000000000000000DEAD01'
    await mdb.index('storedEventOwners').addDocuments([{
      key: relegatedPubKeyHex,
      entityType: 'pubkey',
      popularityLevel: 5, // Was 5, but now will be Demoted
      usedBytes: 100
    }])

    // 4. Setup Events for Relegation
    await mdb.index('events').addDocuments([{
      ref: 'ev1',
      pubkey: relegatedPubKeyHex,
      ip: '1.2.3.4',
      byteSize: 100,
      ownerType: 'pubkey', // Needs to change to ip
      kind: 1, created_at: 100, tags: [], content: '', sig: ''
    }])

    await new Promise(resolve => setTimeout(resolve, 100))

    // Run with background processor for pendingOps (needed for relegateEvents loop)
    const runLoop = async () => {
      try {
        await runPendingOps()
      } catch (e) {
        if (e.code !== 'document_not_found') console.error(e)
      } finally {
        if (processor) processor = setTimeout(runLoop, 200)
      }
    }
    let processor = setTimeout(runLoop, 200)

    try {
      await maintainStorageTiersJob.default.run()
    } finally {
      clearTimeout(processor)
      processor = null
      await runPendingOps() // Drain remaining
    }

    await new Promise(resolve => setTimeout(resolve, 500)) // Wait for async queueOps/processing?

    // Check if event was updated (since pendingOps should be processed)
    const event = await mdb.index('events').getDocument('ev1')
    assert.equal(event.ownerType, 'ip', 'Event should be relegated to ip')

    // Check usage update
    // We can't check delta op easily if it's gone. Check stored usage if possible?
    // storedEventOwners for 'relegatedPubKey' should have 0 bytes (removed)
    // But update is delta.
    const owner = await mdb.index('storedEventOwners').getDocument(relegatedPubKeyHex)
    assert.equal(owner.usedBytes, 0, 'Usage should be decremented')
  })

  it('should NOT relegate VIP pubkey events even when popularity > 5', async () => {
    // 1. Setup Jobs
    await mdb.index('jobs').addDocuments([{ key: 'calcPopularPubkeys', endedAt: 999999 }])

    // 2. Use a VIP pubkey
    const vipPubkey = [...VIP_PUBKEYS][0]

    // 3. Setup Stored Event Owner for VIP
    await mdb.index('storedEventOwners').addDocuments([{
      key: vipPubkey,
      entityType: 'pubkey',
      popularityLevel: 999, // VIP may not be in any popular filter
      usedBytes: 500
    }])

    // 4. Setup Events for VIP
    await mdb.index('events').addDocuments([{
      ref: 'vip_ev1',
      pubkey: vipPubkey,
      ip: '5.5.5.5',
      byteSize: 500,
      ownerType: 'pubkey',
      kind: 1, created_at: 100, tags: [], content: 'vip event', sig: 'sig'
    }])

    await new Promise(resolve => setTimeout(resolve, 100))

    // Run with background processor
    const runLoop = async () => {
      try {
        await runPendingOps()
      } catch (e) {
        if (e.code !== 'document_not_found') console.error(e)
      } finally {
        if (processor) processor = setTimeout(runLoop, 200)
      }
    }
    let processor = setTimeout(runLoop, 200)

    try {
      await maintainStorageTiersJob.default.run()
    } finally {
      clearTimeout(processor)
      processor = null
      await runPendingOps() // Drain remaining
    }

    await new Promise(resolve => setTimeout(resolve, 500))

    // VIP event should still be owned by pubkey (NOT relegated to ip)
    const event = await mdb.index('events').getDocument('vip_ev1')
    assert.equal(event.ownerType, 'pubkey', 'VIP event should NOT be relegated to ip')

    // VIP owner usedBytes should be unchanged
    const owner = await mdb.index('storedEventOwners').getDocument(vipPubkey)
    assert.equal(owner.usedBytes, 500, 'VIP usedBytes should remain unchanged')
  })
})
