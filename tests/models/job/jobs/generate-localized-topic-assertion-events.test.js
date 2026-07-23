import { describe, it, before, beforeEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import { toHashtagStatsKey } from '#helpers/mdb.js'
import hashtagStatsSchema from '#models/hashtag-stats/schema.js'
import { patchIcons } from '#models/hashtag-stats/dao.js'
import { eventKinds } from '#constants/event.js'
import { getRelaySelfPubkey } from '#helpers/relay-self.js'
import { isValidEvent } from 'libp2r2p/event'

describe('Job: Generate Localized Topic Assertion Events', () => {
  let generateJob
  let queueOpsMock

  before(async () => {
    queueOpsMock = mock.fn(async () => {})

    mock.module('#services/event/maintainer/mdb/index.js', {
      namedExports: {
        queueOps: queueOpsMock,
        pruneEvents: async () => 0,
        checkStorageLimitAndPrune: async () => ({})
      }
    })

    mock.module('#services/topic/icon-resolver.js', {
      namedExports: {
        resolveIconsBatch: mock.fn(async (items) => {
          const map = new Map()
          for (const { tag } of items) {
            map.set(tag, `https://icon.test/${tag}.png`)
          }
          return map
        }),
        resolveIcon: mock.fn(async () => null),
        _resetHealthCache: mock.fn(() => {}),
        warmHealthCache: mock.fn(async () => {}),
        isBackedOff: mock.fn(() => false),
        recordSuccess: mock.fn(async () => {}),
        recordFailure: mock.fn(async () => {}),
        FAILURES_BEFORE_BACKOFF: 3,
        BASE_BACKOFF_MS: 300000,
        MAX_BACKOFF_MS: 86400000,
        CONCURRENCY: 3
      }
    })

    generateJob = await import('#models/job/jobs/generate-localized-topic-assertion-events.js')
  })

  after(() => {
    mock.restoreAll()
  })

  beforeEach(async () => {
    queueOpsMock.mock.resetCalls()
    // Clear indexes
    await mdb.index('events').deleteAllDocuments()
    try {
      await mdb.index('hashtagStats').deleteAllDocuments()
    } catch (_e) {
      // Index may not exist yet; create it
      try {
        await mdb.createIndex('hashtagStats', { primaryKey: hashtagStatsSchema.primaryKey })
        await mdb.index('hashtagStats').updateSettings(hashtagStatsSchema.settings)
      } catch (_e2) { /* already exists */ }
    }
  })

  it('config should have correct structure', () => {
    assert.equal(generateJob.default.key, 'generateLocalizedTopicAssertionEvents')
    assert.equal(generateJob.default.frequency, 600) // 10 minutes
    assert.equal(generateJob.default.shouldUseLock, true)
    assert.equal(typeof generateJob.default.run, 'function')
  })

  it('should do nothing when hashtagStats is empty', async () => {
    await generateJob.run()
    assert.equal(queueOpsMock.mock.calls.length, 0)
  })

  it('should skip topics with count below MIN_TOPIC_COUNT', async () => {
    await mdb.index('hashtagStats').addDocuments([
      { key: toHashtagStatsKey('en', 'lowcount'), lang: 'en', tag: 'lowcount', count: 2, neighbors: [], statsUpdatedAt: Date.now() }
    ])

    await generateJob.run()
    assert.equal(queueOpsMock.mock.calls.length, 0)
  })

  it('should generate signed kind 30385 events with rank and iso639 d tag', async () => {
    const selfPubkey = getRelaySelfPubkey()

    await mdb.index('hashtagStats').addDocuments([
      {
        key: toHashtagStatsKey('en', 'bitcoin'),
        lang: 'en',
        tag: 'bitcoin',
        count: 100,
        neighbors: [['crypto', 50], ['blockchain', 30]],
        statsUpdatedAt: Date.now()
      },
      {
        key: toHashtagStatsKey('en', 'crypto'),
        lang: 'en',
        tag: 'crypto',
        count: 80,
        neighbors: [['bitcoin', 40]],
        statsUpdatedAt: Date.now()
      }
    ])

    await generateJob.run()

    assert.equal(queueOpsMock.mock.calls.length, 1)
    const ops = queueOpsMock.mock.calls[0].arguments[0]

    // Should have 2 insertOrReplaceDocument ops (one per topic)
    const insertOps = ops.filter(op => op.type === 'insertOrReplaceDocument')
    assert.equal(insertOps.length, 2)

    // Verify the first event (bitcoin, position 0 = highest count)
    const bitcoinOp = insertOps[0]
    const doc = bitcoinOp.data.document
    assert.equal(doc.kind, eventKinds.I_TAG_TRUSTED_ASSERTION)
    assert.equal(doc.pubkey, selfPubkey)
    assert.equal(doc.language, 'en')
    assert.equal(doc.popularityLevel, 1)

    // Verify indexable tags include iso639 d tag and t tags
    const indexableTags = doc.indexableTags || []
    assert.ok(indexableTags.some(t => t.startsWith('d iso639:en:#bitcoin')), 'd tag should use iso639 prefix')
    assert.ok(indexableTags.some(t => t === 't bitcoin'))

    // Verify rank tag exists: position 0 of 2 → rank 100
    const tags = reconstructTags(doc)
    const rankTag = tags.find(t => t[0] === 'rank')
    assert.ok(rankTag, 'rank tag should exist')
    assert.equal(rankTag[1], '100')

    // Verify second event has lower rank: position 1 of 2 → rank 1
    const cryptoOp = insertOps[1]
    const cryptoDoc = cryptoOp.data.document
    const cryptoTags = reconstructTags(cryptoDoc)
    const cryptoRankTag = cryptoTags.find(t => t[0] === 'rank')
    assert.ok(cryptoRankTag, 'crypto rank tag should exist')
    assert.equal(cryptoRankTag[1], '1')

    // Verify neighbor ranks are normalized 1-100 (not raw counts)
    const bitcoinTags = tags.filter(t => t[0] === 't' && t.length >= 4)
    for (const neighborTag of bitcoinTags) {
      const rank = parseInt(neighborTag[3], 10)
      assert.ok(rank >= 1 && rank <= 100, `neighbor rank ${rank} should be between 1 and 100`)
    }

    // Validate event signature
    const signedEvent = {
      id: doc.id,
      pubkey: doc.pubkey,
      kind: doc.kind,
      created_at: doc.created_at,
      content: doc.ftsContent ?? doc.nonFtsContent ?? '',
      tags,
      sig: doc.sig
    }
    assert.ok(isValidEvent(signedEvent), 'Event signature should be valid')
  })

  it('should include icon tag when icon is resolved for a topic', async () => {
    await mdb.index('hashtagStats').addDocuments([
      {
        key: toHashtagStatsKey('en', 'pokemon'),
        lang: 'en',
        tag: 'pokemon',
        count: 50,
        neighbors: [],
        statsUpdatedAt: Date.now()
        // no 'icon' field — should be resolved by the mock
      }
    ])

    await generateJob.run()

    assert.equal(queueOpsMock.mock.calls.length, 1)
    const ops = queueOpsMock.mock.calls[0].arguments[0]
    const insertOps = ops.filter(op => op.type === 'insertOrReplaceDocument')
    assert.equal(insertOps.length, 1)

    const doc = insertOps[0].data.document
    const tags = reconstructTags(doc)
    const iconTag = tags.find(t => t[0] === 'icon')
    assert.ok(iconTag, 'should have an icon tag')
    assert.equal(iconTag[1], 'https://icon.test/pokemon.png')
  })

  it('should use cached icon from hashtagStats when available', async () => {
    await mdb.index('hashtagStats').addDocuments([
      {
        key: toHashtagStatsKey('en', 'bitcoin'),
        lang: 'en',
        tag: 'bitcoin',
        count: 100,
        icon: 'https://cached.test/bitcoin.png',
        neighbors: [],
        statsUpdatedAt: Date.now()
      }
    ])

    await generateJob.run()

    assert.equal(queueOpsMock.mock.calls.length, 1)
    const ops = queueOpsMock.mock.calls[0].arguments[0]
    const insertOps = ops.filter(op => op.type === 'insertOrReplaceDocument')
    const doc = insertOps[0].data.document
    const tags = reconstructTags(doc)
    const iconTag = tags.find(t => t[0] === 'icon')
    assert.ok(iconTag, 'should have an icon tag')
    // Cached icon is preferred over newly resolved
    assert.equal(iconTag[1], 'https://cached.test/bitcoin.png')
  })

  it('should queue delete ops for stale events not refreshed in current run', async () => {
    const selfPubkey = getRelaySelfPubkey()

    // Seed a stale topic assertion event in events index
    const { eventToRecord, addressToRef } = await import('#models/event/mapper.js')
    const staleEvent = {
      id: '0'.repeat(63) + '1',
      pubkey: selfPubkey,
      kind: eventKinds.I_TAG_TRUSTED_ASSERTION,
      created_at: 1000,
      tags: [['d', 'iso639:en:#oldtopic'], ['t', 'oldtopic']],
      content: '',
      sig: '0'.repeat(128)
    }
    const staleRecord = eventToRecord(staleEvent, { language: 'en', receivedAt: 1000 })
    await mdb.index('events').addDocuments([{
      ...staleRecord,
      byteSize: 100,
      ownerType: 'pubkey',
      popularityLevel: 1
    }])

    // Seed fresh hashtagStats (different topic)
    await mdb.index('hashtagStats').addDocuments([
      {
        key: toHashtagStatsKey('en', 'newtopic'),
        lang: 'en',
        tag: 'newtopic',
        count: 50,
        neighbors: [],
        statsUpdatedAt: Date.now()
      }
    ])

    await generateJob.run()

    assert.equal(queueOpsMock.mock.calls.length, 1)
    const ops = queueOpsMock.mock.calls[0].arguments[0]

    // Should have 1 insert (newtopic) + 1 delete (oldtopic)
    const insertOps = ops.filter(op => op.type === 'insertOrReplaceDocument')
    const deleteOps = ops.filter(op => op.type === 'deleteDocumentIfExists')

    assert.equal(insertOps.length, 1)
    assert.equal(deleteOps.length, 1)

    // Verify the stale ref is targeted for deletion
    const staleRef = addressToRef({ kind: eventKinds.I_TAG_TRUSTED_ASSERTION, pubkey: selfPubkey, dTag: 'iso639:en:#oldtopic' })
    assert.equal(deleteOps[0].data.key, staleRef)
  })

  it('should process multiple languages independently', async () => {
    await mdb.index('hashtagStats').addDocuments([
      { key: toHashtagStatsKey('en', 'test'), lang: 'en', tag: 'test', count: 10, neighbors: [], statsUpdatedAt: Date.now() },
      { key: toHashtagStatsKey('pt', 'teste'), lang: 'pt', tag: 'teste', count: 15, neighbors: [], statsUpdatedAt: Date.now() }
    ])

    await generateJob.run()

    // Should have 2 calls (one per language)
    assert.equal(queueOpsMock.mock.calls.length, 2)

    const allOps = queueOpsMock.mock.calls.flatMap(call => call.arguments[0])
    const insertOps = allOps.filter(op => op.type === 'insertOrReplaceDocument')
    assert.equal(insertOps.length, 2)

    const languages = insertOps.map(op => op.data.document.language)
    assert.ok(languages.includes('en'))
    assert.ok(languages.includes('pt'))
  })
})

describe('hashtagStats icon batch persistence (real MeiliSearch, no mocks)', () => {
  before(async () => {
    // Ensure the hashtagStats index exists with correct settings
    try {
      await mdb.createIndex('hashtagStats', { primaryKey: hashtagStatsSchema.primaryKey })
    } catch (_e) { /* already exists */ }
    await mdb.index('hashtagStats').updateSettings(hashtagStatsSchema.settings)
  })

  beforeEach(async () => {
    await mdb.index('hashtagStats').deleteAllDocuments()
  })

  it('should patch multiple icons in a single call via patchIcons DAO', async () => {
    // Seed two documents
    await mdb.index('hashtagStats').addDocuments([
      { key: toHashtagStatsKey('en', 'bitcoin'), lang: 'en', tag: 'bitcoin', count: 100, neighbors: [], statsUpdatedAt: Date.now() },
      { key: toHashtagStatsKey('en', 'crypto'), lang: 'en', tag: 'crypto', count: 80, neighbors: [], statsUpdatedAt: Date.now() }
    ])

    // Use the DAO function
    await patchIcons({
      [toHashtagStatsKey('en', 'bitcoin')]: 'https://example.com/bitcoin.png',
      [toHashtagStatsKey('en', 'crypto')]: 'https://example.com/crypto.png'
    })

    // Verify icons were set
    const btc = await mdb.index('hashtagStats').getDocument(toHashtagStatsKey('en', 'bitcoin'))
    assert.equal(btc.icon, 'https://example.com/bitcoin.png')

    const crypto = await mdb.index('hashtagStats').getDocument(toHashtagStatsKey('en', 'crypto'))
    assert.equal(crypto.icon, 'https://example.com/crypto.png')
  })

  it('should NOT insert phantom docs for keys that do not exist', async () => {
    // Seed only one document
    await mdb.index('hashtagStats').addDocuments([
      { key: toHashtagStatsKey('en', 'bitcoin'), lang: 'en', tag: 'bitcoin', count: 100, neighbors: [], statsUpdatedAt: Date.now() }
    ])

    // Use the DAO function with a map that includes a non-existent key
    await patchIcons({
      [toHashtagStatsKey('en', 'bitcoin')]: 'https://example.com/bitcoin.png',
      [toHashtagStatsKey('en', 'nonexistent')]: 'https://example.com/nonexistent.png'
    })

    // Existing doc should be updated
    const btc = await mdb.index('hashtagStats').getDocument(toHashtagStatsKey('en', 'bitcoin'))
    assert.equal(btc.icon, 'https://example.com/bitcoin.png')

    // Non-existent key should NOT have been created
    try {
      await mdb.index('hashtagStats').getDocument(toHashtagStatsKey('en', 'nonexistent'))
      assert.fail('Should not find a phantom document for nonexistent key')
    } catch (err) {
      // Expected: document_not_found
      assert.ok(
        err.code === 'document_not_found' || err.cause?.code === 'document_not_found',
        'Should get document_not_found error'
      )
    }
  })

  it('should only patch docs matched by the filter', async () => {
    // Seed three documents
    await mdb.index('hashtagStats').addDocuments([
      { key: toHashtagStatsKey('en', 'bitcoin'), lang: 'en', tag: 'bitcoin', count: 100, neighbors: [], statsUpdatedAt: Date.now() },
      { key: toHashtagStatsKey('en', 'crypto'), lang: 'en', tag: 'crypto', count: 80, neighbors: [], statsUpdatedAt: Date.now() },
      { key: toHashtagStatsKey('en', 'nft'), lang: 'en', tag: 'nft', count: 60, neighbors: [], statsUpdatedAt: Date.now() }
    ])

    // Use the DAO function to patch only bitcoin
    await patchIcons({ [toHashtagStatsKey('en', 'bitcoin')]: 'https://example.com/bitcoin.png' })

    // bitcoin should have icon
    const btc = await mdb.index('hashtagStats').getDocument(toHashtagStatsKey('en', 'bitcoin'))
    assert.equal(btc.icon, 'https://example.com/bitcoin.png')

    // crypto and nft should NOT have icon
    const crypto = await mdb.index('hashtagStats').getDocument(toHashtagStatsKey('en', 'crypto'))
    assert.equal(crypto.icon, undefined)

    const nft = await mdb.index('hashtagStats').getDocument(toHashtagStatsKey('en', 'nft'))
    assert.equal(nft.icon, undefined)
  })

  it('should preserve existing fields when patching icon', async () => {
    const now = Date.now()
    await mdb.index('hashtagStats').addDocuments([
      {
        key: toHashtagStatsKey('en', 'bitcoin'),
        lang: 'en',
        tag: 'bitcoin',
        count: 100,
        neighbors: [['crypto', 50]],
        statsUpdatedAt: now
      }
    ])

    // Use the DAO function
    await patchIcons({ [toHashtagStatsKey('en', 'bitcoin')]: 'https://example.com/bitcoin.png' })

    const doc = await mdb.index('hashtagStats').getDocument(toHashtagStatsKey('en', 'bitcoin'))
    assert.equal(doc.icon, 'https://example.com/bitcoin.png')
    assert.equal(doc.lang, 'en')
    assert.equal(doc.tag, 'bitcoin')
    assert.equal(doc.count, 100)
    assert.deepEqual(doc.neighbors, [['crypto', 50]])
    assert.equal(doc.statsUpdatedAt, now)
  })
})

function reconstructTags (doc) {
  const tags = Array.isArray(doc.nonIndexableTags) ? [...doc.nonIndexableTags] : []
  const indexableTags = doc.indexableTags || []
  const indexableTagExtras = doc.indexableTagExtras || []
  for (let i = 0; i < indexableTags.length; i++) {
    const [k, v] = indexableTags[i].split(' ', 2)
    const [tagIndex, ...extraValues] = indexableTagExtras[i]
    tags.splice(tagIndex, 0, [k, v, ...extraValues])
  }
  return tags
}
