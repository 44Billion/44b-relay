import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { detectTopics, _cache } from '#services/topic/detector.js'

// Helper to populate the cache directly for testing
function populateCache (lang, docs) {
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

  _cache.set(lang, { byTag, byWord, byAcronym, docs, refreshedAt: Date.now() })
}

describe('detectTopics', () => {
  beforeEach(() => {
    _cache.clear()
  })

  describe('Phase 1: Direct hashtags', () => {
    it('should return direct hashtags as topics', () => {
      const result = detectTopics({
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

    it('should return direct hashtags even without cache', () => {
      const result = detectTopics({
        language: 'en',
        hashtags: [{ tag: 'bitcoin', words: ['bitcoin'], acronym: null }],
        text: 'BTC to the moon'
      })
      assert.deepEqual(result, ['bitcoin'])
    })
  })

  describe('Phase 2: Directional neighbor expansion', () => {
    it('should expand topics with frequent neighbors', () => {
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

      const result = detectTopics({
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

    it('should NOT add neighbors below directional ratio threshold', () => {
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

      const result = detectTopics({
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
    it('should expand with morphological synonyms', () => {
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

      const result = detectTopics({
        language: 'en',
        hashtags: [{ tag: 'sport', words: ['sport'], acronym: null }],
        text: 'Sport is life'
      })

      assert.ok(result)
      assert.ok(result.includes('sport'))
      assert.ok(result.includes('sports'), 'morphological synonym "sports" should be added')
    })

    it('should expand with acronym synonyms', () => {
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

      const result = detectTopics({
        language: 'en',
        hashtags: [{ tag: 'ahashtagexample', words: ['a', 'hashtag', 'example'], acronym: 'ahe' }],
        text: 'Test'
      })

      assert.ok(result)
      assert.ok(result.includes('ahashtagexample'))
      assert.ok(result.includes('ahe'))
    })

    it('should expand with context-based synonyms (shared prefix + top neighbors)', () => {
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

      const result = detectTopics({
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
    it('should infer topics from text when words match a rare known tag', () => {
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

      const result = detectTopics({
        language: 'en',
        hashtags: [],
        text: 'I love pokemon so much it is the greatest anime ever'
      })

      assert.ok(result)
      assert.ok(result.includes('pokemon'))
      assert.ok(result.includes('anime'))
    })

    it('should infer topics when two related candidates appear in text', () => {
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

      const result = detectTopics({
        language: 'en',
        hashtags: [],
        text: 'The bitcoin and crypto markets are volatile today'
      })

      assert.ok(result)
      assert.ok(result.includes('bitcoin'))
      assert.ok(result.includes('crypto'))
      // blockchain is a neighbor of both bitcoin (2000/5000=40%) and crypto (1500/4000=37.5%) → expanded
      assert.ok(result.includes('blockchain'))
    })

    it('should NOT infer topics from text below count threshold', () => {
      populateCache('en', [
        {
          tag: 'rareword',
          words: ['rareword'],
          acronym: null,
          count: 2, // below MIN_TAG_COUNT_FOR_INFERENCE (3)
          neighbors: []
        }
      ])

      const result = detectTopics({
        language: 'en',
        hashtags: [],
        text: 'This is about rareword something'
      })

      assert.equal(result, undefined)
    })

    it('should return undefined when no topics can be detected', () => {
      const result = detectTopics({
        language: 'en',
        hashtags: [],
        text: 'Just a random sentence with no recognizable topics'
      })
      assert.equal(result, undefined)
    })
  })

  describe('Language scoping', () => {
    it('should use language-specific cache', () => {
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
      const enResult = detectTopics({
        language: 'en',
        hashtags: [{ tag: 'futebol', words: ['futebol'], acronym: null }],
        text: 'futebol'
      })
      assert.deepEqual(enResult, ['futebol'])

      // Portuguese cache has the data
      const ptResult = detectTopics({
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
    it('should handle no language gracefully', () => {
      const result = detectTopics({
        language: undefined,
        hashtags: [{ tag: 'test', words: ['test'], acronym: null }],
        text: 'test'
      })
      assert.deepEqual(result, ['test'])
    })

    it('should handle empty hashtags and empty text', () => {
      const result = detectTopics({
        language: 'en',
        hashtags: [],
        text: ''
      })
      assert.equal(result, undefined)
    })

    it('should handle undefined text', () => {
      const result = detectTopics({
        language: 'en',
        hashtags: [],
        text: undefined
      })
      assert.equal(result, undefined)
    })

    it('should cap topics at MAX_TOPICS (12)', () => {
      const hashtags = Array.from({ length: 20 }, (_, i) => ({
        tag: `tag${i}abcdef`,
        words: [`tag${i}abcdef`],
        acronym: null
      }))
      const result = detectTopics({ language: 'en', hashtags, text: 'test' })
      assert.ok(result)
      assert.ok(result.length <= 12)
    })
  })
})
