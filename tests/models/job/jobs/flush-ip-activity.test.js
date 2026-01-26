import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
// Import service to track activity
import { trackIpActivity } from '#services/event/tracker/mdb/ip-activity.js'
import * as flushIpActivityJob from '#models/job/jobs/flush-ip-activity.js'

describe('Job: Flush IP Activity', () => {
  beforeEach(async () => {
    await mdb.index('pendingOps').deleteAllDocuments()
  })

  it('should flush tracked activity to pendingOps', async () => {
    // 1. Track activity
    trackIpActivity({ ip: '192.168.1.1' })

    // 2. Run Job
    await flushIpActivityJob.run()
    await new Promise(resolve => setTimeout(resolve, 100))

    // 3. Assert
    const { results } = await mdb.index('pendingOps').getDocuments()

    // Should have 2 ops: mergeSketch and patchDocumentIfExists (activeAt)
    assert.ok(results.length >= 2) // Could be more if logic splits?

    const mergeOp = results.find(op => op.type === 'mergeSketch')
    const patchOp = results.find(op => op.type === 'patchDocumentIfExists' && op.data.document.entityType === 'ip')

    assert.ok(mergeOp)
    assert.ok(patchOp)
  })

  it('should do nothing if no activity', async () => {
    // run again (previous run cleared state)
    await flushIpActivityJob.run()
    await new Promise(resolve => setTimeout(resolve, 100))

    // Should be no NEW ops.
    // But we didn't clear pendingOps between runs in this test block.
    // But beforeEach clears it. This is a new test.

    const { results } = await mdb.index('pendingOps').getDocuments()
    assert.equal(results.length, 0)
  })

  it('config should have correct structure', () => {
    assert.equal(flushIpActivityJob.default.key, 'flushIpActivity')
    assert.equal(typeof flushIpActivityJob.default.run, 'function')
  })
})
