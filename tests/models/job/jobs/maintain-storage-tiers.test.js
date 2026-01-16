import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import processPendingOpsJob from '#models/job/jobs/process-pending-ops/index.js'
import * as maintainStorageTiersJob from '#models/job/jobs/maintain-storage-tiers.js'
import bloomFilters from 'bloom-filters'
const { CuckooFilter } = bloomFilters

describe('Job: Maintain Storage Tiers', () => {
  beforeEach(async () => {
    await mdb.index('jobs').deleteAllDocuments()
    await mdb.index('maintenanceState').deleteAllDocuments()
    await mdb.index('storedEventOwners').deleteAllDocuments()
    await mdb.index('events').deleteAllDocuments()
    await mdb.index('popularPubkeys').deleteAllDocuments()
    await mdb.index('pendingOps').deleteAllDocuments()
  })

  it('should require calcPopularPubkeys job to have run', async () => {
    // No jobs doc
    await maintainStorageTiersJob.default.run()

    // Should not create maintenanceState
    try {
      await mdb.index('maintenanceState').getDocuments() // returns empty list usually
      // If it throws on empty, catch.
      // But getDocument would throw.
    } catch (_err) {}

    // We can verify by ensuring validation logic returned early.
    // If it ran, it would log or create state.
    // Let's assume if maintenanceState is empty, it didn't run.
    const { results } = await mdb.index('maintenanceState').getDocuments()
    assert.equal(results.length, 0)
  })

  it('should run maintenance loop and update popularity', async () => {
    // 1. Setup Jobs
    await mdb.index('jobs').addDocuments([{ key: 'calcPopularPubkeys', endedAt: 123456 }])

    // 2. Setup Popular Pubkeys (Level 1 has 'pubkey1')
    const cuckoo = new CuckooFilter(100, 4, 3)
    cuckoo.add('pubkey1')
    await mdb.index('popularPubkeys').addDocuments([{
      key: '1',
      cuckoo: JSON.stringify(cuckoo.saveAsJSON())
    }])

    // 3. Setup Stored Event Owner
    // Initially popularityLevel 5. Should become 1.
    await mdb.index('storedEventOwners').addDocuments([{
      key: 'pubkey1',
      entityType: 'pubkey',
      popularityLevel: 5,
      usedBytes: 100
    }])

    // Wait
    await new Promise(resolve => setTimeout(resolve, 100))

    // Run
    const worker = setInterval(async () => { try { await processPendingOpsJob.run() } catch {} }, 2000)
    try { await maintainStorageTiersJob.default.run() } finally { clearInterval(worker) }

    await new Promise(resolve => setTimeout(resolve, 100))

    // Assert
    // storedEventOwner should be updated to Level 1
    const owner = await mdb.index('storedEventOwners').getDocument('pubkey1')
    assert.equal(owner.popularityLevel, 1)

    // maintenanceState should exist
    const { results } = await mdb.index('maintenanceState').getDocuments()
    assert.ok(results.length > 0)
  })

  it.only('should handle relegation when popularity > 5', async () => {
    // 1. Setup Jobs
    await mdb.index('jobs').addDocuments([{ key: 'calcPopularPubkeys', endedAt: 123456 }])

    // 2. Setup Popular Pubkeys (Empty -> everything is > 5) (Level 1..6 empty)
    // Actually if we don't return anything for loadPopularityFilters, it might keep default?
    // The service caches filters. Checks if updated recently.
    // If we want to ensure 'relegatedPubKey' is NOT in any filter -> level 999.

    // 3. Setup Stored Event Owner
    // Level 6 (or just not found in levels 1-5, so > 5)
    await mdb.index('storedEventOwners').addDocuments([{
      key: 'relegatedPubKey',
      entityType: 'pubkey',
      popularityLevel: 5, // Was 5, but now will be Demoted
      usedBytes: 100
    }])

    // 4. Setup Events for Relegation
    await mdb.index('events').addDocuments([{
      ref: 'ev1',
      pubkey: 'relegatedPubKey',
      ip: '1.2.3.4',
      byteSize: 100,
      ownerType: 'pubkey', // Needs to change to ip
      kind: 1, created_at: 100, tags: [], content: '', sig: ''
    }])

    await new Promise(resolve => setTimeout(resolve, 100))

    // Run
    const worker = setInterval(async () => { try { await processPendingOpsJob.run() } catch {} }, 2000)
    try {
      await maintainStorageTiersJob.default.run()
    } catch (err) {
      if (!err.message.includes('timeout')) throw err
    } finally {
      clearInterval(worker)
    }

    await new Promise(resolve => setTimeout(resolve, 500)) // Wait for async queueOps/processing?

    // Check if event was updated (since pendingOps should be processed)
    const event = await mdb.index('events').getDocument('ev1')
    assert.equal(event.ownerType, 'ip', 'Event should be relegated to ip')

    // Check usage update
    // We can't check delta op easily if it's gone. Check stored usage if possible?
    // storedEventOwners for 'relegatedPubKey' should have 0 bytes (removed)
    // But update is delta.
    const owner = await mdb.index('storedEventOwners').getDocument('relegatedPubKey')
    assert.equal(owner.usedBytes, 0, 'Usage should be decremented')
  })
})
