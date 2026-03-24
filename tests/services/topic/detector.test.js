import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { detectTopics, _cache } from '#services/topic/detector.js'

// Helper to populate the cache directly for testing
function populateCache (lang, docs, { embeddings = new Map() } = {}) {
  const byTag = new Map()
  const byWord = new Map()
  const byAcronym = new Map()

  for (const doc of docs) {
    byTag.set(doc.tag, doc)

    if (doc.words?.length) {
      for (const w of doc.words) {
        if (!byWord.has(w)) byWord.set(w, new Set())
        byWord.get(w).add(doc.tag)
      }
    }

    if (doc.acronym) {
      if (!byAcronym.has(doc.acronym)) byAcronym.set(doc.acronym, new Set())
      byAcronym.get(doc.acronym).add(doc.tag)
    }
  }

  _cache.set(lang, { byTag, byWord, byAcronym, embeddings, docs, refreshedAt: Date.now() })
}

describe('detectTopics', () => {
  beforeEach(() => {
    _cache.clear()
  })

  describe('Phase 1: Direct hashtags', () => {
    it('should return direct hashtags as topics', async () => {
      const result = await detectTopics({
        language: 'en',
        hashtags: [
          { tag: 'pokemon', words: ['pokemon'], acronym: null },
          { tag: 'anime', words: ['anime'], acronym: null }
        ],
        text: 'Gotta catch them all'
      })
      assert.ok(result)
      assert.ok(result.includes('pokemon'))
      assert.ok(result.includes('anime'))
    })

    it('should return direct hashtags even without cache', async () => {
      const result = await detectTopics({
        language: 'en',
        hashtags: [{ tag: 'bitcoin', words: ['bitcoin'], acronym: null }],
        text: 'BTC to the moon'
      })
      assert.deepEqual(result, ['bitcoin'])
    })
  })

  describe('Phase 2: Directional neighbor expansion', () => {
    it('should expand topics with frequent neighbors', async () => {
      populateCache('en', [
        {
          tag: 'ashketchum',
          words: ['ash', 'ketchum'],
          acronym: 'ak',
          count: 100,
          neighbors: [['pokemon', 80], ['anime', 60], ['pikachu', 40]]
        },
        {
          tag: 'pokemon',
          words: ['pokemon'],
          acronym: null,
          count: 1000,
          neighbors: [['anime', 500], ['ashketchum', 20]]
        },
        {
          tag: 'anime',
          words: ['anime'],
          acronym: null,
          count: 2000,
          neighbors: [['pokemon', 800]]
        },
        {
          tag: 'pikachu',
          words: ['pikachu'],
          acronym: null,
          count: 200,
          neighbors: [['pokemon', 180]]
        }
      ])

      const result = await detectTopics({
        language: 'en',
        hashtags: [{ tag: 'ashketchum', words: ['ash', 'ketchum'], acronym: 'ak' }],
        text: 'Ash is the best trainer'
      })

      assert.ok(result)
      assert.ok(result.includes('ashketchum'))
      // 80/100 = 0.8 > 0.3 → pokemon should be added
      assert.ok(result.includes('pokemon'))
      // 60/100 = 0.6 > 0.3 → anime should be added
      assert.ok(result.includes('anime'))
      // 40/100 = 0.4 > 0.3 → pikachu should be added
      assert.ok(result.includes('pikachu'))
    })

    it('should NOT add neighbors below directional ratio threshold', async () => {
      populateCache('en', [
        {
          tag: 'pokemon',
          words: ['pokemon'],
          acronym: null,
          count: 1000,
          neighbors: [['ashketchum', 20]] // 20/1000 = 0.02 < 0.3
        },
        {
          tag: 'ashketchum',
          words: ['ash', 'ketchum'],
          acronym: 'ak',
          count: 100,
          neighbors: []
        }
      ])

      const result = await detectTopics({
        language: 'en',
        hashtags: [{ tag: 'pokemon', words: ['pokemon'], acronym: null }],
        text: 'Pokemon is great'
      })

      assert.ok(result)
      assert.ok(result.includes('pokemon'))
      assert.ok(!result.includes('ashketchum'))
    })
  })

  describe('Phase 3: Synonym expansion', () => {
    it('should expand with morphological synonyms', async () => {
      populateCache('en', [
        {
          tag: 'sport',
          words: ['sport'],
          acronym: null,
          count: 500,
          neighbors: [['football', 200]]
        },
        {
          tag: 'sports',
          words: ['sports'],
          acronym: null,
          count: 800,
          neighbors: [['football', 300]]
        },
        {
          tag: 'football',
          words: ['football'],
          acronym: null,
          count: 400,
          neighbors: [['sport', 150]]
        }
      ])

      const result = await detectTopics({
        language: 'en',
        hashtags: [{ tag: 'sport', words: ['sport'], acronym: null }],
        text: 'Sport is life'
      })

      assert.ok(result)
      assert.ok(result.includes('sport'))
      assert.ok(result.includes('sports'), 'morphological synonym "sports" should be added')
    })

    it('should expand with acronym synonyms', async () => {
      populateCache('en', [
        {
          tag: 'ahashtagexample',
          words: ['a', 'hashtag', 'example'],
          acronym: 'ahe',
          count: 100,
          neighbors: []
        },
        {
          tag: 'ahe',
          words: ['ahe'],
          acronym: null,
          count: 50,
          neighbors: []
        }
      ])

      const result = await detectTopics({
        language: 'en',
        hashtags: [{ tag: 'ahashtagexample', words: ['a', 'hashtag', 'example'], acronym: 'ahe' }],
        text: 'Test'
      })

      assert.ok(result)
      assert.ok(result.includes('ahashtagexample'))
      assert.ok(result.includes('ahe'))
    })

    it('should expand with context-based synonyms (shared prefix + top neighbors)', async () => {
      populateCache('en', [
        {
          tag: 'ashketchum',
          words: ['ash', 'ketchum'],
          acronym: 'ak',
          count: 100,
          neighbors: [['pokemon', 80], ['anime', 60], ['pikachu', 40]]
        },
        {
          tag: 'ash',
          words: ['ash'],
          acronym: null,
          count: 200,
          neighbors: [['pokemon', 140], ['anime', 100], ['fire', 20]]
        },
        {
          tag: 'pokemon',
          words: ['pokemon'],
          acronym: null,
          count: 1000,
          neighbors: [['anime', 500]]
        },
        {
          tag: 'anime',
          words: ['anime'],
          acronym: null,
          count: 2000,
          neighbors: [['pokemon', 800]]
        },
        {
          tag: 'pikachu',
          words: ['pikachu'],
          acronym: null,
          count: 200,
          neighbors: [['pokemon', 180]]
        }
      ])

      const result = await detectTopics({
        language: 'en',
        hashtags: [{ tag: 'ashketchum', words: ['ash', 'ketchum'], acronym: 'ak' }],
        text: 'Ash goes on an adventure'
      })

      assert.ok(result)
      assert.ok(result.includes('ashketchum'))
      assert.ok(result.includes('ash'), 'context-based synonym "ash" should be added')
    })
  })

  describe('Phase 4: Text inference (no hashtags)', () => {
    it('should infer topics from text when words match a rare known tag', async () => {
      populateCache('en', [
        {
          tag: 'pokemon',
          words: ['pokemon'],
          acronym: null,
          count: 500,
          neighbors: [['anime', 300], ['pikachu', 200]]
        },
        {
          tag: 'anime',
          words: ['anime'],
          acronym: null,
          count: 2000,
          neighbors: [['pokemon', 800]]
        },
        {
          tag: 'pikachu',
          words: ['pikachu'],
          acronym: null,
          count: 200,
          neighbors: [['pokemon', 180]]
        }
      ])

      const result = await detectTopics({
        language: 'en',
        hashtags: [],
        text: 'I love pokemon so much it is the greatest anime ever'
      })

      assert.ok(result)
      assert.ok(result.includes('pokemon'))
      assert.ok(result.includes('anime'))
    })

    it('should infer topics when two related candidates appear in text', async () => {
      populateCache('en', [
        {
          tag: 'bitcoin',
          words: ['bitcoin'],
          acronym: null,
          count: 5000,
          neighbors: [['crypto', 3000], ['blockchain', 2000]]
        },
        {
          tag: 'crypto',
          words: ['crypto'],
          acronym: null,
          count: 4000,
          neighbors: [['bitcoin', 2500], ['blockchain', 1500]]
        },
        {
          tag: 'blockchain',
          words: ['blockchain'],
          acronym: null,
          count: 2000,
          neighbors: [['bitcoin', 1500], ['crypto', 1000]]
        }
      ])

      const result = await detectTopics({
        language: 'en',
        hashtags: [],
        text: 'The bitcoin and crypto markets are volatile today'
      })

      assert.ok(result)
      assert.ok(result.includes('bitcoin'))
      assert.ok(result.includes('crypto'))
      // blockchain is a neighbor of both but below the 80% second-hop threshold → NOT expanded
      assert.ok(!result.includes('blockchain'))
    })

    it('should NOT infer topics from text below count threshold', async () => {
      populateCache('en', [
        {
          tag: 'rareword',
          words: ['rareword'],
          acronym: null,
          count: 2, // below MIN_TAG_COUNT_FOR_INFERENCE (3)
          neighbors: []
        }
      ])

      const result = await detectTopics({
        language: 'en',
        hashtags: [],
        text: 'This is about rareword something'
      })

      assert.equal(result, undefined)
    })

    it('should return undefined when no topics can be detected', async () => {
      const result = await detectTopics({
        language: 'en',
        hashtags: [],
        text: 'Just a random sentence with no recognizable topics'
      })
      assert.equal(result, undefined)
    })
  })

  describe('Phase 5: Semantic text inference', () => {
    afterEach(() => { mock.restoreAll() })

    it('should find topics via embedding similarity when no hashtags and Phase 4 found nothing', async () => {
      // Create embeddings: bitcoin pointing strongly in dim 0,
      // 5 other topics pointing in other orthogonal directions.
      // The query vector is close to bitcoin, so bitcoin should be the z-score outlier.
      const makeUnitVec = (dim) => {
        const v = new Float32Array(384).fill(0); v[dim] = 1; return v
      }

      const embeddingsMap = new Map()
      embeddingsMap.set('bitcoin', makeUnitVec(0))
      embeddingsMap.set('photography', makeUnitVec(1))
      embeddingsMap.set('cooking', makeUnitVec(2))
      embeddingsMap.set('music', makeUnitVec(3))
      embeddingsMap.set('sports', makeUnitVec(4))

      const docs = [
        { tag: 'bitcoin', words: ['bitcoin'], acronym: null, count: 5000, neighbors: [] },
        { tag: 'photography', words: ['photography'], acronym: null, count: 3000, neighbors: [] },
        { tag: 'cooking', words: ['cooking'], acronym: null, count: 2000, neighbors: [] },
        { tag: 'music', words: ['music'], acronym: null, count: 4000, neighbors: [] },
        { tag: 'sports', words: ['sports'], acronym: null, count: 2500, neighbors: [] }
      ]

      populateCache('en', docs, { embeddings: embeddingsMap })

      // Mock query embedding: very close to bitcoin's direction
      const mockEmbedding = new Float32Array(384).fill(0)
      mockEmbedding[0] = 0.99
      mockEmbedding[1] = Math.sqrt(1 - 0.99 * 0.99)

      mock.module('#services/topic/embedder.js', {
        namedExports: {
          embedText: async () => mockEmbedding,
          cosineSimilarity: (a, b) => {
            let dot = 0; for (let i = 0; i < a.length; i++) dot += a[i] * b[i]; return dot
          },
          EMBEDDING_DIMS: 384
        }
      })

      const result = await detectTopics({
        language: 'en',
        hashtags: [],
        text: 'I just bought some cryptocurrency assets'
      })

      assert.ok(result, 'expected topics to be found via Phase 5')
      assert.ok(result.includes('bitcoin'), `expected bitcoin in ${result}`)
    })

    it('should not run Phase 5 when hashtags are present', async () => {
      const embeddingsMap = new Map()
      embeddingsMap.set('bitcoin', new Float32Array(384).fill(0.1))

      populateCache('en', [
        { tag: 'bitcoin', words: ['bitcoin'], acronym: null, count: 5000, neighbors: [] }
      ], { embeddings: embeddingsMap })

      let embedCallCount = 0
      mock.module('#services/topic/embedder.js', {
        namedExports: {
          embedText: async () => { embedCallCount++; return new Float32Array(384) },
          cosineSimilarity: () => 0.9,
          EMBEDDING_DIMS: 384
        }
      })

      // hashtags present → Phase 5 should not fire
      await detectTopics({
        language: 'en',
        hashtags: [{ tag: 'bitcoin', words: ['bitcoin'], acronym: null }],
        text: 'some text'
      })

      assert.equal(embedCallCount, 0, 'embedText should not be called when hashtags are present')
    })

    it('should not run Phase 5 when Phase 4 already found topics', async () => {
      const embeddingsMap = new Map()
      embeddingsMap.set('bitcoin', new Float32Array(384).fill(0.1))

      populateCache('en', [
        { tag: 'bitcoin', words: ['bitcoin'], acronym: null, count: 5000, neighbors: [] }
      ], { embeddings: embeddingsMap })

      let embedCallCount = 0
      mock.module('#services/topic/embedder.js', {
        namedExports: {
          embedText: async () => { embedCallCount++; return new Float32Array(384) },
          cosineSimilarity: () => 0.9,
          EMBEDDING_DIMS: 384
        }
      })

      // Phase 4 will match 'bitcoin' from the text
      await detectTopics({
        language: 'en',
        hashtags: [],
        text: 'I love bitcoin so much'
      })

      assert.equal(embedCallCount, 0, 'embedText should not be called when Phase 4 already found topics')
    })

    it('should gracefully degrade when embedder returns null', async () => {
      const embeddingsMap = new Map()
      for (const tag of ['tagone', 'tagtwo', 'tagthree', 'tagfour', 'tagfive']) {
        embeddingsMap.set(tag, new Float32Array(384).fill(0.1))
      }

      populateCache('en', [
        { tag: 'tagone', words: ['tagone'], acronym: null, count: 5000, neighbors: [] },
        { tag: 'tagtwo', words: ['tagtwo'], acronym: null, count: 3000, neighbors: [] },
        { tag: 'tagthree', words: ['tagthree'], acronym: null, count: 2000, neighbors: [] },
        { tag: 'tagfour', words: ['tagfour'], acronym: null, count: 4000, neighbors: [] },
        { tag: 'tagfive', words: ['tagfive'], acronym: null, count: 2500, neighbors: [] }
      ], { embeddings: embeddingsMap })

      mock.module('#services/topic/embedder.js', {
        namedExports: {
          embedText: async () => null,
          cosineSimilarity: () => 0,
          EMBEDDING_DIMS: 384
        }
      })

      const result = await detectTopics({
        language: 'en',
        hashtags: [],
        text: 'some random text that would not match Phase 4'
      })

      assert.equal(result, undefined, 'should return undefined gracefully when embedder fails')
    })
  })

  describe('Language scoping', () => {
    it('should use language-specific cache', async () => {
      populateCache('pt', [
        {
          tag: 'futebol',
          words: ['futebol'],
          acronym: null,
          count: 1000,
          neighbors: [['esporte', 500]]
        },
        {
          tag: 'esporte',
          words: ['esporte'],
          acronym: null,
          count: 2000,
          neighbors: [['futebol', 800]]
        }
      ])

      // English cache is empty
      const enResult = await detectTopics({
        language: 'en',
        hashtags: [{ tag: 'futebol', words: ['futebol'], acronym: null }],
        text: 'futebol'
      })
      assert.deepEqual(enResult, ['futebol'])

      // Portuguese cache has the data
      const ptResult = await detectTopics({
        language: 'pt',
        hashtags: [{ tag: 'futebol', words: ['futebol'], acronym: null }],
        text: 'futebol'
      })
      assert.ok(ptResult)
      assert.ok(ptResult.includes('futebol'))
      assert.ok(ptResult.includes('esporte'))
    })
  })

  describe('Edge cases', () => {
    it('should handle no language gracefully', async () => {
      const result = await detectTopics({
        language: undefined,
        hashtags: [{ tag: 'test', words: ['test'], acronym: null }],
        text: 'test'
      })
      assert.deepEqual(result, ['test'])
    })

    it('should handle empty hashtags and empty text', async () => {
      const result = await detectTopics({
        language: 'en',
        hashtags: [],
        text: ''
      })
      assert.equal(result, undefined)
    })

    it('should handle undefined text', async () => {
      const result = await detectTopics({
        language: 'en',
        hashtags: [],
        text: undefined
      })
      assert.equal(result, undefined)
    })

    it('should cap topics at MAX_TOPICS (12)', async () => {
      const hashtags = Array.from({ length: 20 }, (_, i) => ({
        tag: `tag${i}abcdef`,
        words: [`tag${i}abcdef`],
        acronym: null
      }))
      const result = await detectTopics({ language: 'en', hashtags, text: 'test' })
      assert.ok(result)
      assert.ok(result.length <= 12)
    })
  })
})
