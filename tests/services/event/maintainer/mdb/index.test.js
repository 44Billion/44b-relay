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
        { id: '1', ref: '1', pubkey, ownerType: 'pubkey', kind: 1, byteSize: 100, created_at: 10 },
        { id: '2', ref: '2', pubkey, ownerType: 'pubkey', kind: 1, byteSize: 100, created_at: 20 },
        { id: '3', ref: '3', pubkey, ownerType: 'pubkey', kind: 1, byteSize: 100, created_at: 30 }
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

    it('should prefer deleting chunk events (kind 34601) first for pubkey owner', async () => {
      const pubkey = '0000000000000000000000000000000000000000000000000000000000000013'

      // Seed: 1 regular event + 2 chunk events
      const events = [
        { id: 'txt1', ref: 'txt1', pubkey, ownerType: 'pubkey', kind: 1, byteSize: 100, created_at: 10, content: 'text' },
        { id: 'chunk1', ref: 'chunk1', pubkey, ownerType: 'pubkey', kind: 34601, byteSize: 51000, created_at: 20 },
        { id: 'chunk2', ref: 'chunk2', pubkey, ownerType: 'pubkey', kind: 34601, byteSize: 51000, created_at: 30 }
      ]
      await mdb.index('events').addDocuments(events)

      // Request to remove 60000 bytes — chunk1 (51000) should be enough
      const cleared = await maintainer.pruneEvents({
        ownerKey: pubkey,
        ownerType: 'pubkey',
        bytesToRemove: 60000
      })

      assert.ok(cleared >= 60000)

      // The text event should survive since chunks covered the bytesToRemove
      const { results } = await mdb.index('events').getDocuments({ limit: 100 })
      const remaining = results.filter(e => e.pubkey === pubkey)
      assert.ok(remaining.find(e => e.id === 'txt1'), 'Text event should survive when chunks cover the needed space')
    })

    it('should not apply the legacy multiple-c-tag pruning exception', async () => {
      const pubkey = '0000000000000000000000000000000000000000000000000000000000000014'

      const events = [
        { id: 'shared1', ref: 'shared1', pubkey, ownerType: 'pubkey', kind: 34601, byteSize: 51000, created_at: 10, indexableTags: ['c legacy-a', 'c legacy-b'] },
        { id: 'single1', ref: 'single1', pubkey, ownerType: 'pubkey', kind: 34601, byteSize: 51000, created_at: 20 },
        // Regular event
        { id: 'txt2', ref: 'txt2', pubkey, ownerType: 'pubkey', kind: 1, byteSize: 100, created_at: 5, content: 'text' }
      ]
      await mdb.index('events').addDocuments(events)

      const cleared = await maintainer.pruneEvents({
        ownerKey: pubkey,
        ownerType: 'pubkey',
        bytesToRemove: 51000
      })

      assert.ok(cleared >= 51000)

      const { results } = await mdb.index('events').getDocuments({ limit: 100 })
      const remaining = results.filter(e => e.pubkey === pubkey)

      // Chunk pruning no longer reads c tags; both chunks are handled alike.
      assert.ok(!remaining.find(e => e.id === 'shared1'), 'Oldest chunk should be deleted despite multiple c tags')
      assert.ok(remaining.find(e => e.id === 'txt2'), 'Text event should survive')
    })

    it('should fall through to general pruning when chunks are not enough', async () => {
      const pubkey = '0000000000000000000000000000000000000000000000000000000000000015'

      const events = [
        { id: 'chunk3', ref: 'chunk3', pubkey, ownerType: 'pubkey', kind: 34601, byteSize: 100, created_at: 10 },
        { id: 'txt3', ref: 'txt3', pubkey, ownerType: 'pubkey', kind: 1, byteSize: 200, created_at: 20, content: 'text' }
      ]
      await mdb.index('events').addDocuments(events)

      // Request more than the chunk provides
      const cleared = await maintainer.pruneEvents({
        ownerKey: pubkey,
        ownerType: 'pubkey',
        bytesToRemove: 250
      })

      assert.ok(cleared >= 250)

      // Both should be deleted since chunk (100) wasn't enough for 250
      const { results } = await mdb.index('events').getDocuments({ limit: 100 })
      const remaining = results.filter(e => e.pubkey === pubkey)
      assert.equal(remaining.length, 0, 'All events should be deleted when chunks alone are not enough')
    })

    it('should never consume subsidized manifests for an ordinary owner prune', async () => {
      const pubkey = '0000000000000000000000000000000000000000000000000000000000000016'
      await mdb.index('events').addDocuments([
        { id: 'manifest', ref: 'manifest', pubkey, ownerType: 'pubkey', kind: 35128, byteSize: 1000, created_at: 1 },
        { id: 'ordinary', ref: 'ordinary', pubkey, ownerType: 'pubkey', kind: 1, byteSize: 200, created_at: 2 }
      ])

      const cleared = await maintainer.pruneEvents({ ownerKey: pubkey, ownerType: 'pubkey', bytesToRemove: 100 })
      assert.equal(cleared, 200)
      assert.equal((await mdb.index('events').getDocument('manifest')).kind, 35128)
      await assert.rejects(mdb.index('events').getDocument('ordinary'))
    })

    it('should handle IP owner pruning (delete non-popular first)', async () => {
      // This is complex to test fully without mocking popularity filters,
      // but we can test the deletion mechanism.
      // Assuming current popularity is not loaded or 999, it deletes everything?

      // We will mock loadPopularityFilters if possible, or just rely on default (999)
      // If all are non-popular, they get deleted.

      const ip = '1.2.3.4'
      const events = [
        { id: 'ip1', ref: 'ip1', ip, ownerType: 'ip', kind: 1, pubkey: 'aaa0000000000000000000000000000000000000000000000000000000000001', byteSize: 100, created_at: 10 },
        { id: 'ip2', ref: 'ip2', ip, ownerType: 'ip', kind: 1, pubkey: 'bbb0000000000000000000000000000000000000000000000000000000000001', byteSize: 100, created_at: 20 }
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
