import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eventKinds } from '#constants/event.js'

// Mock dependencies
const queueOpsMock = mock.fn()
mock.module('#services/event/maintainer/mdb/index.js', {
  namedExports: {
    queueOps: queueOpsMock
  }
})

// Helper to mock getIpScore
mock.module('#services/event/tracker/mdb/ip-activity.js', {
  namedExports: {
    getIpScore: () => 0 // Always return 0 (not spam)
  }
})

// Dynamic import to allow mocking
const {
  getFilterInterests,
  trackRequestedPubkeys,
  flushRequestedPubkeysToMDB,
  uninterestedIn
} = await import('#services/event/tracker/mdb/requested-pubkeys.js')

describe('Requested Pubkeys Tracker', () => {
  beforeEach(() => {
    queueOpsMock.mock.resetCalls()
    // Ensure cache is empty by flushing
    flushRequestedPubkeysToMDB()
    queueOpsMock.mock.resetCalls()
  })

  describe('getFilterInterests', () => {
    it('should extract interesting pubkeys from authors filter', () => {
      const filters = [{ authors: ['pubkey1', 'pubkey2'] }]
      const result = getFilterInterests({ filters })

      assert.deepEqual(result.pubkeys, new Set(['pubkey1', 'pubkey2']))
      assert.deepEqual(result.ids, {})
    })

    it('should extract interesting ids when no authors', () => {
      const filters = [{ ids: ['id1', 'id2'] }]
      const result = getFilterInterests({ filters })

      assert.deepEqual(result.pubkeys, new Set())
      assert.deepEqual(result.ids, { id1: true, id2: true })
    })

    it('should prioritize authors over ids', () => {
      const filters = [{ authors: ['pubkey1'], ids: ['id1'] }]
      const result = getFilterInterests({ filters })

      assert.deepEqual(result.pubkeys, new Set(['pubkey1']))
      assert.deepEqual(result.ids, {})
    })
  })

  describe('trackRequestedPubkeys & flushRequestedPubkeysToMDB', () => {
    it('should not queue ops if no pubkeys tracked', async () => {
      await flushRequestedPubkeysToMDB()
      assert.equal(queueOpsMock.mock.callCount(), 0)
    })

    it('should track and flush pubkeys', async () => {
      const pubkeys = ['pubkeyA']
      const ip = '127.0.0.1'

      trackRequestedPubkeys({ pubkeys, ip })
      await flushRequestedPubkeysToMDB()

      assert.equal(queueOpsMock.mock.callCount(), 1)
      const ops = queueOpsMock.mock.calls[0].arguments[0]
      assert.equal(ops.length, 1)
      assert.equal(ops[0].type, 'mergeHll')
      assert.equal(ops[0].data.key, 'pubkeyA')
      // Valid Base64 (URL safe or standard)
      assert.match(ops[0].data.hll, /^[A-Za-z0-9+/_=-]+$/)
    })

    it('should aggregate multiple tracks across flushes', async () => {
      // Since we can't easily inspect internal cache state directly without exporting it,
      // we trust the functional behavior.
      // But the previous test flushed.

      const pubkeys = ['pubkeyB']
      trackRequestedPubkeys({ pubkeys, ip: '1.2.3.4' })
      trackRequestedPubkeys({ pubkeys, ip: '5.6.7.8' })

      await flushRequestedPubkeysToMDB()

      assert.equal(queueOpsMock.mock.callCount(), 1)
      const ops = queueOpsMock.mock.calls[0].arguments[0]
      assert.equal(ops.length, 1)
      assert.equal(ops[0].data.key, 'pubkeyB')
    })
  })

  describe('uninterestedIn', () => {
    it('should define uninterested kinds', () => {
      assert.equal(uninterestedIn.kinds[eventKinds.METADATA], true)
      assert.equal(uninterestedIn.kinds[eventKinds.READ_WRITE_RELAYS], true)
    })
  })
})
