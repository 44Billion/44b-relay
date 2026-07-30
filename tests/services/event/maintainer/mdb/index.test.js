import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import * as maintainer from '#services/event/maintainer/mdb/index.js'

import { ipToPrimaryKey } from '#helpers/mdb.js'

describe('Event Maintainer (MDB)', () => {
  beforeEach(async () => {
    // Clear relevant indexes for fresh start
    // Using try-catch just in case indexes don't exist yet/initialization issues, though migration should handle it
    try {
      await mdb.index('pendingOps').deleteAllDocuments()
      await mdb.index('storedEventOwners').deleteAllDocuments()
      await mdb.index('events').deleteAllDocuments()
    } catch (err) {
      console.warn('Error clearing indexes:', err.message)
    }
  })

  describe('queueOps', () => {
    it('should do nothing if ops list is empty', async () => {
      await maintainer.queueOps([])
      const res = await mdb.index('pendingOps').getDocuments()
      assert.equal(res.results.length, 0)
    })

    it('should queue operations to pendingOps index', async () => {
      const ops = [
        { type: 'test', data: { key: 'abc', foo: 'bar' } }
      ]
      await maintainer.queueOps(ops)

      const res = await mdb.index('pendingOps').search('', { limit: 10 })
      assert.equal(res.hits.length, 1)

      const doc = res.hits[0]
      assert.equal(doc.type, 'test')
      // Data is stored as object now
      const parsedData = doc.data
      assert.equal(parsedData.foo, 'bar')
      assert.equal(parsedData.key, 'abc')
      assert.ok(doc.key) // UUID present
      assert.match(doc.key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      assert.match(doc.batchId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      assert.ok(doc.createdAt)
    })

    it('preserves array order with explicit batch positions', async () => {
      const nowMock = mock.method(Date, 'now', () => 123456789)
      try {
        await Promise.all([
          maintainer.queueOps([
            { type: 'a0', data: {} },
            { type: 'a1', data: {} },
            { type: 'a2', data: {} }
          ]),
          maintainer.queueOps([
            { type: 'b0', data: {} },
            { type: 'b1', data: {} }
          ])
        ])
      } finally {
        nowMock.mock.restore()
      }

      const { hits } = await mdb.index('pendingOps').search('', {
        limit: 10,
        sort: ['createdAt:asc', 'batchId:asc', 'position:asc', 'key:asc']
      })
      assert.equal(new Set(hits.map(op => op.key)).size, 5)
      assert.deepEqual(new Set(hits.map(op => op.createdAt)), new Set([123456789]))

      const batches = Map.groupBy(hits, op => op.batchId)
      assert.equal(batches.size, 2)
      const orderedTypes = [...batches.values()].map(batch => batch.map(op => op.type))
      assert.ok(orderedTypes.some(types => JSON.stringify(types) === JSON.stringify(['a0', 'a1', 'a2'])))
      assert.ok(orderedTypes.some(types => JSON.stringify(types) === JSON.stringify(['b0', 'b1'])))
      for (const batch of batches.values()) {
        assert.deepEqual(batch.map(op => op.position), batch.map((_op, index) => index))
      }
    })

    it('keeps positions stable when a logical batch crosses the processor batch size', async () => {
      await maintainer.queueOps(Array.from({ length: 101 }, (_value, index) => ({
        type: `op-${index}`,
        data: { index }
      })))
      const { hits } = await mdb.index('pendingOps').search('', {
        limit: 200,
        sort: ['createdAt:asc', 'batchId:asc', 'position:asc', 'key:asc']
      })
      assert.equal(hits.length, 101)
      assert.equal(new Set(hits.map(op => op.batchId)).size, 1)
      assert.deepEqual(hits.map(op => op.position), Array.from({ length: 101 }, (_value, index) => index))
    })
  })

  describe('checkStorageLimitAndPrune', () => {
    it('should handle regular pubkey (not popular) -> defaults to IP limit', async () => {
      const pubkey = 'pk1'
      const ip = '127.0.0.1'

      // Ensure no stored entity exists (clean state)

      const result = await maintainer.checkStorageLimitAndPrune({
        pubkey,
        ip,
        newEventSize: 1000,
        popularityLevel: 999
      })

      assert.equal(result.ownerType, 'ip')
      assert.equal(result.ownerKey, ipToPrimaryKey(ip))
      assert.equal(result.popularityLevel, 999)

      const ops = result.ops
      const usageOp = ops.find(o => o.type === 'deltaUsage')
      assert.ok(usageOp)
      // Now key is encoded for IP
      assert.equal(usageOp.data.key, ipToPrimaryKey(ip))
      assert.equal(usageOp.data.delta, 1000)

      // Check that pruneCheck is NOT created (usage tiny)
      const pruneOp = ops.find(o => o.type === 'pruneCheck')
      assert.equal(pruneOp, undefined)
    })

    it('should handle popular pubkey -> uses pubkey limit', async () => {
      const pubkey = '0000000000000000000000000000000000000000000000000000000000000010'
      const ip = '1.1.1.1'

      const result = await maintainer.checkStorageLimitAndPrune({
        pubkey,
        ip,
        newEventSize: 500,
        popularityLevel: 1
      })

      assert.equal(result.ownerType, 'pubkey')
      assert.equal(result.ownerKey, pubkey)
      assert.equal(result.popularityLevel, 1)

      const ops = result.ops
      const usageOp = ops.find(o => o.type === 'deltaUsage')
      assert.equal(usageOp.data.key, pubkey)
      assert.equal(usageOp.data.entityType, 'pubkey')
    })

    it('should trigger pruneCheck if usage is near limit', async () => {
      const pubkey = '0000000000000000000000000000000000000000000000000000000000000011'
      const ip = '2.2.2.2'
      const level = 5 // 20 MB limit
      const limit = 20 * 1024 * 1024

      // Seed DB with high usage
      // 19MB usage
      const currentUsage = 19 * 1024 * 1024

      await mdb.index('storedEventOwners').addDocuments([{
        key: pubkey,
        entityType: 'pubkey',
        usedBytes: currentUsage,
        popularityLevel: level
      }])

      const result = await maintainer.checkStorageLimitAndPrune({
        pubkey,
        ip,
        newEventSize: 1024 * 1024, // +1MB -> hits limit
        popularityLevel: level
      })

      const pruneOp = result.ops.find(o => o.type === 'pruneCheck')
      assert.ok(pruneOp, 'Should generate pruneCheck op')
      assert.equal(pruneOp.data.limit, limit)
      assert.equal(pruneOp.data.targetBytes, Math.floor(limit * 0.9))
      assert.equal(pruneOp.data.workflowVersion, 2)
      assert.equal(pruneOp.data.key, pubkey)
    })

    it('should handle missing stored entity (404) by treating usage as 0', async () => {
      const pubkey = 'pk_new'
      const ip = '3.3.3.3'

      // Ensure nothing in DB

      const result = await maintainer.checkStorageLimitAndPrune({
        pubkey,
        ip,
        newEventSize: 500,
        popularityLevel: 999
      })

      assert.equal(result.ownerType, 'ip')
      const ops = result.ops
      const pruneOp = ops.find(o => o.type === 'pruneCheck')
      assert.equal(pruneOp, undefined)

      // We rely on integration test logic implicitly checking that no error was thrown
    })

    it('should handle VIP pubkey -> force pubkey owner and skip pruneCheck', async () => {
      // Use one of the VIP keys
      const vipPubkey = [...maintainer.VIP_PUBKEYS][0]
      const ip = '4.4.4.4'

      const result = await maintainer.checkStorageLimitAndPrune({
        pubkey: vipPubkey,
        ip,
        newEventSize: 1000,
        popularityLevel: 999
      })

      assert.equal(result.ownerType, 'pubkey')
      assert.equal(result.ownerKey, vipPubkey)
      assert.equal(result.popularityLevel, 999)

      const ops = result.ops
      const usageOp = ops.find(o => o.type === 'deltaUsage')
      assert.ok(usageOp)
      assert.equal(usageOp.data.key, vipPubkey)

      const pruneOp = ops.find(o => o.type === 'pruneCheck')
      assert.equal(pruneOp, undefined, 'Should skip pruneCheck for VIP')
    })
  })

  describe('getStoredEntity', () => {
    it('should return default object if entity not found', async () => {
      const res = await maintainer.getStoredEntity({ key: 'missing', type: 'pubkey' })
      assert.equal(res.usedBytes, 0)
      assert.equal(res.popularityLevel, 999)
    })

    it('should return stored entity if exists', async () => {
      await mdb.index('storedEventOwners').addDocuments([{
        key: 'existing',
        entityType: 'pubkey',
        usedBytes: 500,
        popularityLevel: 2
      }])

      const res = await maintainer.getStoredEntity({ key: 'existing', type: 'pubkey' })
      assert.equal(res.usedBytes, 500)
      assert.equal(res.popularityLevel, 2)
    })
  })
})
