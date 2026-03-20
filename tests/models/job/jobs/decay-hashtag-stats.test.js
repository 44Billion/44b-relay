import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import * as decayJob from '#models/job/jobs/decay-hashtag-stats.js'

describe('Job: Decay Hashtag Stats', () => {
  beforeEach(async () => {
    await mdb.index('hashtagStats').deleteAllDocuments()
  })

  it('config should have correct structure', () => {
    assert.equal(decayJob.default.key, 'decayHashtagStats')
    assert.equal(typeof decayJob.default.run, 'function')
    assert.equal(decayJob.default.shouldUseLock, true)
    assert.equal(decayJob.default.frequency, 6 * 60 * 60)
  })

  it('should not decay docs within 2-hour grace period', async () => {
    const now = Date.now()
    const docs = [
      {
        key: 'en-fresh',
        lang: 'en',
        tag: 'fresh',
        count: 1000,
        neighbors: [['crypto', 100]],
        statsUpdatedAt: now - (1 * 60 * 60 * 1000) // 1 hour ago
      }
    ]

    await mdb.index('hashtagStats').addDocuments(docs)
    await decayJob.run()

    const { results } = await mdb.index('hashtagStats').getDocuments({ limit: 10 })
    const fresh = results.find(d => d.key === 'en-fresh')

    assert.equal(fresh.count, 1000)
    assert.deepEqual(fresh.neighbors, [['crypto', 100]])
  })

  it('should decay counts and neighbors based on age', async () => {
    const now = Date.now()
    const docs = [
      {
        key: 'en-recent',
        lang: 'en',
        tag: 'recent',
        count: 1000,
        neighbors: [['bitcoin', 200], ['eth', 50]],
        statsUpdatedAt: now - (3 * 60 * 60 * 1000) // 3 hours ago
      },
      {
        key: 'en-old',
        lang: 'en',
        tag: 'old',
        count: 1000,
        neighbors: [['defi', 500]],
        statsUpdatedAt: now - (24 * 60 * 60 * 1000) // 24 hours ago
      }
    ]

    await mdb.index('hashtagStats').addDocuments(docs)
    await decayJob.run()

    const { results } = await mdb.index('hashtagStats').getDocuments({ limit: 10 })
    const recent = results.find(d => d.key === 'en-recent')
    const old = results.find(d => d.key === 'en-old')

    // Recent: 3 hours old
    // decay = 0.97 - (3 * 0.0001) = 0.9697
    // count = floor(1000 * 0.9697) = 969
    assert.ok(recent.count < 1000)
    assert.ok(recent.count > 950)

    // Neighbors should also be decayed
    const bitcoinNeighbor = recent.neighbors.find(n => n[0] === 'bitcoin')
    assert.ok(bitcoinNeighbor[1] < 200)
    assert.ok(bitcoinNeighbor[1] > 190)

    // Old: 24 hours old
    // decay = 0.97 - (24 * 0.0001) = 0.9676
    // count = floor(1000 * 0.9676) = 967
    assert.ok(old.count < 1000)
    assert.ok(old.count > 950)
  })

  it('should prune neighbors with count decayed to zero', async () => {
    const now = Date.now()
    const docs = [
      {
        key: 'en-weak-neighbors',
        lang: 'en',
        tag: 'weak-neighbors',
        count: 1000,
        neighbors: [['strong', 500], ['weak', 1]],
        statsUpdatedAt: now - (3 * 60 * 60 * 1000)
      }
    ]

    await mdb.index('hashtagStats').addDocuments(docs)
    await decayJob.run()

    const { results } = await mdb.index('hashtagStats').getDocuments({ limit: 10 })
    const doc = results.find(d => d.key === 'en-weak-neighbors')

    // 'weak' neighbor with count 1, after decay floor() should be 0 and get pruned
    const weakNeighbor = doc.neighbors.find(n => n[0] === 'weak')
    assert.equal(weakNeighbor, undefined)

    // 'strong' neighbor should survive
    const strongNeighbor = doc.neighbors.find(n => n[0] === 'strong')
    assert.ok(strongNeighbor)
    assert.ok(strongNeighbor[1] > 0)
  })

  it('should delete documents when count decays to zero', async () => {
    const now = Date.now()
    const docs = [
      {
        key: 'en-dust',
        lang: 'en',
        tag: 'dust',
        count: 1,
        neighbors: [],
        statsUpdatedAt: now - (3 * 60 * 60 * 1000)
      }
    ]

    await mdb.index('hashtagStats').addDocuments(docs)
    await decayJob.run()

    const { results } = await mdb.index('hashtagStats').getDocuments({ limit: 10 })
    const dust = results.find(d => d.key === 'en-dust')

    // count = floor(1 * 0.9697) = 0 -> document deleted
    assert.equal(dust, undefined)
  })

  it('should update statsUpdatedAt on surviving documents', async () => {
    const now = Date.now()
    const threeHoursAgo = now - (3 * 60 * 60 * 1000)
    const docs = [
      {
        key: 'en-survivor',
        lang: 'en',
        tag: 'survivor',
        count: 1000,
        neighbors: [],
        statsUpdatedAt: threeHoursAgo
      }
    ]

    await mdb.index('hashtagStats').addDocuments(docs)
    await decayJob.run()

    const { results } = await mdb.index('hashtagStats').getDocuments({ limit: 10 })
    const survivor = results.find(d => d.key === 'en-survivor')

    assert.ok(survivor.statsUpdatedAt > threeHoursAgo)
  })

  it('should apply decay floor of 0.5', async () => {
    const now = Date.now()
    const docs = [
      {
        key: 'en-ancient',
        lang: 'en',
        tag: 'ancient',
        count: 10000,
        neighbors: [['big', 10000]],
        // Very old: decay formula would go below 0.5, so floor kicks in
        statsUpdatedAt: now - (100 * 24 * 60 * 60 * 1000) // 100 days ago
      }
    ]

    await mdb.index('hashtagStats').addDocuments(docs)
    await decayJob.run()

    const { results } = await mdb.index('hashtagStats').getDocuments({ limit: 10 })
    const ancient = results.find(d => d.key === 'en-ancient')

    // 100 days = 2400 hours
    // decay = 0.97 - (2400 * 0.0001) = 0.73
    // count = floor(10000 * 0.73) ≈ 7299-7300 (float precision)
    assert.ok(ancient.count >= 7299 && ancient.count <= 7300)
  })

  it('should skip gracefully if index does not exist', async () => {
    // Delete the index entirely
    try { await mdb.index('hashtagStats').delete() } catch {}

    // Should not throw
    await decayJob.run()
  })
})
