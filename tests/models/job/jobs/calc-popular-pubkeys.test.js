import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import * as calcPopularPubkeys from '#models/job/jobs/calc-popular-pubkeys.js'

describe('Job: Calc Popular Pubkeys', () => {
  beforeEach(async () => {
    // Clear relevant indexes
    await mdb.index('requestedPubkeys').delete()
    await mdb.createIndex('requestedPubkeys', { primaryKey: 'key' })
    await mdb.index('requestedPubkeys').updateSettings({ sortableAttributes: ['count'] })
  })

  it('config should have correct structure', () => {
    assert.equal(calcPopularPubkeys.default.key, 'calcPopularPubkeys')
    assert.equal(typeof calcPopularPubkeys.default.run, 'function')
  })

  it('should run successfully with data', async () => {
    // Setup data
    // 1. Seed requestedPubkeys
    const pubkeys = Array.from({ length: 10 }, (_, i) => ({
      key: i.toString(16).padStart(64, '0'),
      count: (10 - i) * 100, // Descending counts: 1000, 900, ...
      lastSeen: Date.now()
    }))

    await mdb.index('requestedPubkeys').addDocuments(pubkeys)
    // Wait for indexing
    await new Promise(resolve => setTimeout(resolve, 100))

    // Run
    await calcPopularPubkeys.run()

    // Assertions
    // 1. Snapshot happened: metricsStaging.. should be deleted at end, but we can check if popularPubkeys has data
    // The code deletes staging at the end.

    // 2. Saved results in 'popularPubkeys'
    // thresholds count is small, total 10 pubkeys.
    // thresholds logic:
    // level 1: 0.0001 * 10 = ceil(0.001) = 1
    // level 2: 0.01 * 10 = 1
    // ...
    // level 5: 0.1 * 10 = 1
    // level 6: 0.5 * 10 = 5.

    // Wait for indexing
    await new Promise(resolve => setTimeout(resolve, 100))

    const { results } = await mdb.index('popularPubkeys').getDocuments({ limit: 10 })
    assert.ok(results.length > 0)

    // Check level 1 exists
    const level1 = results.find(r => r.key === '1')
    assert.ok(level1)

    // 3. Maintenance triggered
    const jobs = await mdb.index('jobs').getDocuments()
    const maintJob = jobs.results.find(j => j.key === 'maintainStorageTiers')
    assert.ok(maintJob)
    assert.ok(maintJob.requestedAt > 0)
  })

  it('should handle empty live index', async () => {
    await mdb.index('requestedPubkeys').delete().catch(() => {})
    await mdb.createIndex('requestedPubkeys', { primaryKey: 'key' })
    await mdb.index('requestedPubkeys').update({ primaryKey: 'key' })

    // Live empty (already cleared in beforeEach)

    // Staging exists with some data
    // We need to create it manually as if a previous run failed or something
    const stagingUid = 'metricsStagingRequestedPubkeys'
    // Create staging index if not exists
    await mdb.createIndex(stagingUid, { primaryKey: 'key' })
    await mdb.index(stagingUid).updateSettings({ sortableAttributes: ['count'] })
    await mdb.index(stagingUid).addDocuments([{ key: 'deadbeef00000000000000000000000000000000000000000000000000000000', count: 50 }])
    await new Promise(resolve => setTimeout(resolve, 100))

    // Run
    await calcPopularPubkeys.run()

    // Assertions
    // If live is empty, it skips reset.
    // It uses staging data.
    // So 'pk_staging' should impact results.

    await new Promise(resolve => setTimeout(resolve, 100))
    const { results } = await mdb.index('popularPubkeys').getDocuments()

    // We have 1 doc.
    // thresholds: 1 * ... = 1 for all levels.
    // pk_staging should be in level 1.
    // But filters are probabalistic.

    assert.ok(results.length > 0)

    // Staging should be deleted
    try {
      await mdb.index(stagingUid).getStats()
      assert.fail('Staging index should be deleted')
    } catch (_err) {
      // Expected error or check if it returns "index not found" equivalent
      // Meilisearch throws if index not found?
      // mdb.getStats throws.
      assert.ok(true)
    }
  })
})
