import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'buffer'
import { ConservativeCountMin } from 'sketch-oxide-node'
import mdb from '#services/db/mdb.js'
import { ipToPrimaryKey } from '#helpers/mdb.js'
import { compressAsync } from '#helpers/buffer.js'
import * as deleteStaleIpsJob from '#models/job/jobs/delete-stale-ips.js'
import {
  loadSystemState,
  processBatch
} from '#models/job/jobs/process-pending-ops/index.js'
import { PENDING_OPS_SORT } from '#models/pending-op/order.js'

describe('Job: Delete Stale IPs', () => {
  beforeEach(async () => {
    await Promise.all([
      mdb.index('ipActivities').deleteAllDocuments(),
      mdb.index('storedEventOwners').deleteAllDocuments(),
      mdb.index('pendingOps').deleteAllDocuments(),
      mdb.index('events').deleteAllDocuments()
    ])
  })

  it('should queue durable stale-IP pruning and keep retained owners', async () => {
    const ONE_DAY = 1000 * 60 * 60 * 24
    const now = Date.now()

    // 1. Setup Global CMS
    const cms = new ConservativeCountMin(0.001, 0.001)
    const highScoreIp = '10.0.0.1'
    const buf = Buffer.from(highScoreIp)
    for (let i = 0; i < 150; i++) {
      cms.update(buf)
    }

    // Save CMS
    const compressed = await compressAsync(cms.serialize())
    await mdb.index('ipActivities').addDocuments([{
      key: 'sketch-current',
      data: compressed.toString('base64url')
    }])

    // 2. Setup storedEventOwners
    const staleIp = '10.0.0.2' // Score 0 -> retention 3 days. Active 4 days ago.
    const freshIp = '10.0.0.3' // Score 0 -> retention 3 days. Active 1 day ago.
    const retainedIp = highScoreIp // Score 150 -> retention 30 days. Active 4 days ago.

    const docs = [
      { key: ipToPrimaryKey(staleIp), entityType: 'ip', usedBytes: 0, lastActiveAt: now - (4 * ONE_DAY) },
      { key: ipToPrimaryKey(freshIp), entityType: 'ip', usedBytes: 0, lastActiveAt: now - (1 * ONE_DAY) },
      { key: ipToPrimaryKey(retainedIp), entityType: 'ip', usedBytes: 0, lastActiveAt: now - (4 * ONE_DAY) }
    ]

    await mdb.index('storedEventOwners').addDocuments(docs)
    // Wait
    await new Promise(resolve => setTimeout(resolve, 100))

    // Run
    await deleteStaleIpsJob.run()
    await new Promise(resolve => setTimeout(resolve, 100))

    // Discovery is non-destructive. Only the stale, low-activity IP gets a
    // durable request, while all owner records remain until that workflow is
    // processed.
    let { results } = await mdb.index('storedEventOwners').getDocuments()
    assert.equal(results.length, 3)
    const { hits } = await mdb.index('pendingOps').search('', {
      limit: 100,
      sort: PENDING_OPS_SORT
    })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].type, 'pruneCheck')
    assert.equal(hits[0].data.key, ipToPrimaryKey(staleIp))
    assert.equal(hits[0].data.deleteOwnerWhenEmpty, true)
    assert.equal(hits[0].data.limit, 0)

    // The regular pending-op consumer completes the recoverable workflow and
    // removes the still-inactive, empty owner atomically.
    await processBatch(hits, await loadSystemState())
    ;({ results } = await mdb.index('storedEventOwners').getDocuments())
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
