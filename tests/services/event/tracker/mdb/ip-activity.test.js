import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'buffer'
import { ConservativeCountMin } from 'sketch-oxide-node'
import mdb from '#services/db/mdb.js'
import { ipToPrimaryKey } from '#helpers/mdb.js'
import { compressAsync } from '#helpers/buffer.js'

const queueOpsMock = mock.fn()
const pruneEventsMock = mock.fn()

mock.module('#services/event/maintainer/mdb/index.js', {
  namedExports: {
    queueOps: queueOpsMock,
    pruneEvents: pruneEventsMock
  }
})

const {
  trackIpActivity,
  flushIpActivityToMDB,
  deleteStaleIps
} = await import('#services/event/tracker/mdb/ip-activity.js')

describe('IP Activity Tracker', () => {
  beforeEach(async () => {
    queueOpsMock.mock.resetCalls()
    pruneEventsMock.mock.resetCalls()
    // Flush to clear internal state
    await flushIpActivityToMDB()
    queueOpsMock.mock.resetCalls()

    // Clear relevant MDB indexes
    try {
      await mdb.index('storedEventOwners').deleteAllDocuments()
      await mdb.index('ipActivities').deleteAllDocuments()
    } catch (_) {}
  })

  // Helper to create and save a Global CMS
  const seedGlobalCMS = async (ipsWithCounts) => {
    // 0.001 error rate, 0.999 confidence
    const cms = new ConservativeCountMin(0.001, 0.001)

    for (const [ip, count] of Object.entries(ipsWithCounts)) {
      const buf = Buffer.from(ip)
      for (let i = 0; i < count; i++) {
        cms.update(buf)
      }
    }

    const compressed = await compressAsync(cms.serialize())
    const doc = {
      key: 'sketch-current', // MDB ID
      data: compressed.toString('base64url')
    }
    await mdb.index('ipActivities').addDocuments([doc])
  }

  // Helper to seed IP owners
  const seedIpOwner = async (ip, lastActiveAt) => {
    await mdb.index('storedEventOwners').addDocuments([{
      key: ipToPrimaryKey(ip),
      entityType: 'ip',
      lastActiveAt
    }])
  }

  describe('deleteStaleIps', () => {
    it('should delete stale IPs and call pruneEvents', async () => {
      const NOW = Date.now()
      const ONE_DAY = 1000 * 60 * 60 * 24

      // 1. Setup Stale IP (Low score, old lastActive)
      // Score < 10 -> Retention 3 days.
      // We set lastActive to 4 days ago.
      const staleIp = '1.1.1.1'
      const staleIpScore = 5
      const staleIpLastActive = NOW - (4 * ONE_DAY)

      // 2. Setup Active IP (Low score, but recent)
      // Score < 10 -> Retention 3 days
      // We set lastActive to 1 day ago
      const activeIp = '2.2.2.2'
      const activeIpScore = 5
      const activeIpLastActive = NOW - (1 * ONE_DAY)

      // 3. Setup High Score IP (High score, old lastActive)
      // Score > 1000 -> Retention 90 days
      // We set lastActive 60 days ago (Old, but kept due to score)
      const popularIp = '3.3.3.3'
      const popularIpScore = 2000
      const popularIpLastActive = NOW - (60 * ONE_DAY)

      // Seed DB
      await seedGlobalCMS({
        [staleIp]: staleIpScore,
        [activeIp]: activeIpScore,
        [popularIp]: popularIpScore
      })

      await seedIpOwner(staleIp, staleIpLastActive)
      await seedIpOwner(activeIp, activeIpLastActive)
      await seedIpOwner(popularIp, popularIpLastActive)

      // Verify seeding (optional for debug, but good for stability)
      // await new Promise(resolve => setTimeout(resolve, 500))

      // Run
      await deleteStaleIps()

      // Assert: pruneEvents called for staleIp
      assert.equal(pruneEventsMock.mock.callCount(), 1)
      const pruneCall = pruneEventsMock.mock.calls[0].arguments[0]
      assert.equal(pruneCall.ownerKey, ipToPrimaryKey(staleIp))
      assert.equal(pruneCall.ownerType, 'ip')

      // Assert: staleIp document deleted
      await assert.rejects(
        async () => await mdb.index('storedEventOwners').getDocument(ipToPrimaryKey(staleIp)),
        (err) => err.code === 'document_not_found' || err.cause?.code === 'document_not_found'
      )

      // Assert: activeIp document exists
      const activeDoc = await mdb.index('storedEventOwners').getDocument(ipToPrimaryKey(activeIp))
      assert.ok(activeDoc)

      // Assert: popularIp document exists
      const popularDoc = await mdb.index('storedEventOwners').getDocument(ipToPrimaryKey(popularIp))
      assert.ok(popularDoc)
    })
  })

  describe('trackIpActivity & flushIpActivityToMDB', () => {
    it('should not queue ops if no activity', async () => {
      await flushIpActivityToMDB()
      assert.equal(queueOpsMock.mock.callCount(), 0)
    })

    it('should track and queue activity', async () => {
      trackIpActivity({ ip: '192.168.1.1' })

      await flushIpActivityToMDB()

      assert.equal(queueOpsMock.mock.callCount(), 1)
      const ops = queueOpsMock.mock.calls[0].arguments[0]
      // Expect 2 ops: mergeSketch and patchDocumentIfExists (for IP owner)
      assert.equal(ops.length, 2)

      const cmsOp = ops.find(op => op.type === 'mergeSketch')
      assert.ok(cmsOp)
      assert.equal(cmsOp.data.targetKey, 'sketch-current')

      const ownerOp = ops.find(op => op.type === 'patchDocumentIfExists')
      assert.ok(ownerOp)
      assert.equal(ownerOp.data.document.key, ipToPrimaryKey('192.168.1.1'))
      assert.equal(ownerOp.data.document.entityType, 'ip')
    })
  })

  // deleteStaleIps is harder to test because it relies on querying mdb and then prunes.
  // We can test detailed behavior if we improve the mocking of mdb interaction.
})
