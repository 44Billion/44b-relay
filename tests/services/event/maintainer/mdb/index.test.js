import { describe, it, beforeEach } from 'node:test'
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
      assert.ok(doc.createdAt)
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

  describe('pruneEvents', () => {
    it('should return early (0) for VIP pubkey', async () => {
      const vipPubkey = [...maintainer.VIP_PUBKEYS][0]
      const result = await maintainer.pruneEvents({
        ownerKey: vipPubkey,
        ownerType: 'pubkey',
        bytesToRemove: 1000
      })
      assert.equal(result, 0)
    })

    it('should delete oldest events for regular pubkey until bytesToRemove is met', async () => {
      const pubkey = '0000000000000000000000000000000000000000000000000000000000000012'
      // Seed events
      const events = [
        { id: '1', ref: '1', pubkey, ownerType: 'pubkey', byteSize: 100, created_at: 10 },
        { id: '2', ref: '2', pubkey, ownerType: 'pubkey', byteSize: 100, created_at: 20 },
        { id: '3', ref: '3', pubkey, ownerType: 'pubkey', byteSize: 100, created_at: 30 }
      ]
      await mdb.index('events').addDocuments(events)

      // Prune 150 bytes. The batch size is 20, so all 3 events (300 bytes)
      // will be fetched and deleted in one go to postpone future pruning.
      const cleared = await maintainer.pruneEvents({
        ownerKey: pubkey,
        ownerType: 'pubkey',
        bytesToRemove: 150
      })

      assert.ok(cleared >= 150)
      assert.equal(cleared, 300)

      // Verify deletion
      const remaining = await mdb.index('events').search('', { filter: `pubkey = ${pubkey}` })
      assert.equal(remaining.hits.length, 0)
    })

    it('should handle IP owner pruning (delete non-popular first)', async () => {
      // This is complex to test fully without mocking popularity filters,
      // but we can test the deletion mechanism.
      // Assuming current popularity is not loaded or 999, it deletes everything?

      // We will mock loadPopularityFilters if possible, or just rely on default (999)
      // If all are non-popular, they get deleted.

      const ip = '1.2.3.4'
      const events = [
        { id: 'ip1', ref: 'ip1', ip, ownerType: 'ip', pubkey: 'aaa0000000000000000000000000000000000000000000000000000000000001', byteSize: 100, created_at: 10 },
        { id: 'ip2', ref: 'ip2', ip, ownerType: 'ip', pubkey: 'bbb0000000000000000000000000000000000000000000000000000000000001', byteSize: 100, created_at: 20 }
      ]
      await mdb.index('events').addDocuments(events)

      const cleared = await maintainer.pruneEvents({
        ownerKey: ipToPrimaryKey(ip),
        ownerType: 'ip',
        bytesToRemove: 50
      })

      assert.ok(cleared >= 100)
      // Should delete oldest 'ip1'
      try {
        await mdb.index('events').getDocument('ip1')
        assert.fail('Should have deleted ip1')
      } catch (e) {
        assert.ok(e.code === 'document_not_found' || e.cause?.code === 'document_not_found')
      }
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
