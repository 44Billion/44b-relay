import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import bloomFilters from 'bloom-filters'
import { ipToPrimaryKey } from '#helpers/mdb.js'
import * as deleteStaleIpsJob from '#models/job/jobs/delete-stale-ips.js'

const { CountMinSketch } = bloomFilters

describe('Job: Delete Stale IPs', () => {
  beforeEach(async () => {
    await mdb.index('ipActivity').deleteAllDocuments()
    await mdb.index('storedEventOwners').deleteAllDocuments()
    // Also clear jobs queue related things if needed? events?
  })

  it('should delete stale IPs and keep retained ones', async () => {
    const ONE_DAY = 1000 * 60 * 60 * 24
    const now = Date.now()

    // 1. Setup Global CMS
    const cms = new CountMinSketch(10, 5) // Small parameters
    const highScoreIp = '10.0.0.1'
    for (let i = 0; i < 150; i++) cms.update(highScoreIp) // Score 150 -> retention 30 days

    // Save CMS
    await mdb.index('ipActivity').addDocuments([{
      key: 'globalCms',
      json: JSON.stringify(cms.saveAsJSON())
    }])

    // 2. Setup storedEventOwners
    const staleIp = '10.0.0.2' // Score 0 -> retention 3 days. Active 4 days ago.
    const freshIp = '10.0.0.3' // Score 0 -> retention 3 days. Active 1 day ago.
    const retainedIp = highScoreIp // Score 150 -> retention 30 days. Active 4 days ago.

    const docs = [
      { key: ipToPrimaryKey(staleIp), entityType: 'ip', lastActiveAt: now - (4 * ONE_DAY) },
      { key: ipToPrimaryKey(freshIp), entityType: 'ip', lastActiveAt: now - (1 * ONE_DAY) },
      { key: ipToPrimaryKey(retainedIp), entityType: 'ip', lastActiveAt: now - (4 * ONE_DAY) }
    ]

    await mdb.index('storedEventOwners').addDocuments(docs)
    // Wait
    await new Promise(resolve => setTimeout(resolve, 100))

    // Run
    await deleteStaleIpsJob.run()
    await new Promise(resolve => setTimeout(resolve, 100))

    // Assert
    const { results } = await mdb.index('storedEventOwners').getDocuments()

    const stale = results.find(d => d.key === ipToPrimaryKey(staleIp))
    const fresh = results.find(d => d.key === ipToPrimaryKey(freshIp))
    const retained = results.find(d => d.key === ipToPrimaryKey(retainedIp))

    assert.equal(!!stale, false, 'Stale IP should be deleted')
    assert.equal(!!fresh, true, 'Fresh IP should be kept')
    assert.equal(!!retained, true, 'High score stale IP should be kept')
  })

  it('config should have correct structure', () => {
    assert.equal(deleteStaleIpsJob.default.key, 'deleteStaleIps')
    assert.equal(typeof deleteStaleIpsJob.default.run, 'function')
  })
})
