import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import * as decayJob from '#models/job/jobs/decay-requested-pubkeys.js'

describe('Job: Decay Requested Pubkeys', () => {
  beforeEach(async () => {
    // Clear relevant indexes
    await mdb.index('requestedPubkeys').deleteAllDocuments()
    // Not needed because mdb client already does that on init
    // Update settings to allow filtering by firstSeenAt
    // await mdb.index('requestedPubkeys').updateSettings({
    //   filterableAttributes: ['firstSeenAt'],
    //   sortableAttributes: ['count', 'firstSeenAt']
    // })
  })

  it('config should have correct structure', () => {
    assert.equal(decayJob.default.key, 'decayRequestedPubkeys')
    assert.equal(typeof decayJob.default.run, 'function')
    assert.equal(decayJob.default.shouldUseLock, true)
    assert.equal(decayJob.default.frequency, 14400)
  })

  it('should decay counts based on age', async () => {
    const now = Date.now()
    const oneDay = 24 * 60 * 60 * 1000
    const docs = [
      {
        key: 'newcomer', // < 2h old
        count: 1000,
        firstSeenAt: now - (1 * 60 * 60 * 1000) // 1 hour old
      },
      {
        key: 'recent', // > 2h old, < 1 day
        count: 1000,
        firstSeenAt: now - (3 * 60 * 60 * 1000) // 3 hours old
      },
      {
        key: 'old', // 10 days old
        count: 1000,
        firstSeenAt: now - (10 * oneDay)
      },
      {
        key: 'ancient', // 100 days old (hits floor 0.5)
        count: 1000,
        firstSeenAt: now - (100 * oneDay)
      }
    ]

    await mdb.index('requestedPubkeys').addDocuments(docs)
    await decayJob.run()

    const { results } = await mdb.index('requestedPubkeys').getDocuments({ limit: 10 })
    const newcomer = results.find(d => d.key === 'newcomer')
    const recent = results.find(d => d.key === 'recent')
    const old = results.find(d => d.key === 'old')
    const ancient = results.find(d => d.key === 'ancient')

    // Newcomer: Should NOT be decayed (grace period)
    assert.equal(newcomer.count, 1000)

    // Recent: 3 hours = 0.125 days.
    // Decay = 0.95 - (0.125 * 0.01) = 0.95 - 0.00125 = 0.94875
    // New Count = 948
    assert.ok(recent.count < 1000)
    assert.ok(recent.count > 940)

    // Old: 10 days.
    // Decay = 0.95 - (10 * 0.01) = 0.95 - 0.1 = 0.85
    // New Count = 850
    assert.ok(old.count < 900)
    assert.ok(old.count > 800)

    // Ancient: 100 days.
    // Decay = 0.95 - (100 * 0.01) = 0.95 - 1.0 = -0.05
    // Floor = 0.5
    // New Count = 500
    assert.equal(ancient.count, 500)
  })

  it('should apply decrement_value when it is more aggressive than percentage decay', async () => {
    const now = Date.now()
    const threeHoursAgo = now - (3 * 60 * 60 * 1000)

    const docs = [
      {
        key: 'max-setter',
        count: 1000000, // maxCount will be 1M
        firstSeenAt: now
      },
      {
        key: 'test-doc',
        count: 1000,
        firstSeenAt: threeHoursAgo // 3h old -> decay factor ~0.948
      }
    ]

    await mdb.index('requestedPubkeys').addDocuments(docs)
    await decayJob.run()

    const { results } = await mdb.index('requestedPubkeys').getDocuments({ limit: 10 })
    const testDoc = results.find(d => d.key === 'test-doc')

    // max_count = 1,000,000
    // decrement_value = floor(1,000,000 * 0.0001) = 100
    // doc.count - decrement_value = 1000 - 100 = 900
    // decayed_count = floor(1000 * 0.948...) = 948
    // new_count = min(948, 900) = 900
    assert.equal(testDoc.count, 900)
  })

  it('should delete documents (dust) when count drops to zero or below', async () => {
    const now = Date.now()
    const threeHoursAgo = now - (3 * 60 * 60 * 1000)

    const docs = [
      {
        key: 'max-setter',
        count: 1000000,
        firstSeenAt: now
      },
      {
        key: 'dust',
        count: 50,
        firstSeenAt: threeHoursAgo
      }
    ]

    await mdb.index('requestedPubkeys').addDocuments(docs)
    await decayJob.run()

    const { results } = await mdb.index('requestedPubkeys').getDocuments({ limit: 10 })
    const dust = results.find(d => d.key === 'dust')

    // max_count = 1,000,000 -> decrement_value = 100
    // doc.count - decrement_value = 50 - 100 = -50
    // new_count <= 0 -> document is deleted (doc = ())
    assert.equal(dust, undefined)
  })
})
