import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import { trackRequestedPubkeys } from '#services/event/tracker/mdb/requested-pubkeys.js'
import * as flushRequestedPubkeysJob from '#models/job/jobs/flush-requested-pubkeys.js'

describe('Job: Flush Requested Pubkeys', () => {
  beforeEach(async () => {
    await mdb.index('pendingOps').deleteAllDocuments()
  })

  it('should flush tracked pubkeys to pendingOps', async () => {
    // 1. Track
    trackRequestedPubkeys({ pubkeys: ['pk1'], ip: '1.2.3.4' })

    // 2. Run
    await flushRequestedPubkeysJob.run()
    await new Promise(resolve => setTimeout(resolve, 100))

    // 3. Assert
    const { results } = await mdb.index('pendingOps').getDocuments()

    // Should have mergeHll ops
    assert.ok(results.length > 0)
    const mergeOp = results.find(op => op.type === 'mergeHll')
    assert.ok(mergeOp)
    assert.equal(mergeOp.data.targetKey, 'pk1')
  })

  it('config should have correct structure', () => {
    assert.equal(flushRequestedPubkeysJob.default.key, 'flushRequestedPubkeys')
    assert.equal(typeof flushRequestedPubkeysJob.default.run, 'function')
  })
})
