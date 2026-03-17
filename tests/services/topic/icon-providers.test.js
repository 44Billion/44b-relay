import { describe, it, before, beforeEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import hashtagStatsSchema from '#models/hashtag-stats/schema.js'

describe('Icon Providers', () => {
  let providers, PROVIDER_TIMEOUT_MS

  before(async () => {
    const mod = await import('#services/topic/icon-providers.js')
    providers = mod.providers
    PROVIDER_TIMEOUT_MS = mod.PROVIDER_TIMEOUT_MS
  })

  it('should export an ordered array of providers', () => {
    assert.ok(Array.isArray(providers))
    assert.ok(providers.length >= 6)

    const names = providers.map(p => p.name)
    assert.ok(names.includes('wikipedia'))
    assert.ok(names.includes('wikidata'))
    assert.ok(names.includes('duckduckgo'))
    assert.ok(names.includes('googleFavicon'))
    assert.ok(names.includes('neighborIcon'))
    assert.ok(names.includes('pollinations'))
  })

  it('each provider should have name and fetchIcon method', () => {
    for (const p of providers) {
      assert.ok(typeof p.name === 'string' && p.name.length > 0)
      assert.ok(typeof p.fetchIcon === 'function')
    }
  })

  it('PROVIDER_TIMEOUT_MS should be a reasonable timeout', () => {
    assert.ok(PROVIDER_TIMEOUT_MS >= 1000)
    assert.ok(PROVIDER_TIMEOUT_MS <= 10000)
  })

  describe('Wikipedia provider', () => {
    const wikipedia = () => providers.find(p => p.name === 'wikipedia')

    it('should return { url } for a well-known topic (mocked)', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async (url) => {
        if (url.includes('wikipedia.org')) {
          return {
            ok: true,
            json: async () => ({
              thumbnail: {
                source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/test.jpg'
              }
            })
          }
        }
        return { ok: false }
      })

      try {
        const result = await wikipedia().fetchIcon('bitcoin', 'en')
        assert.ok(result)
        assert.ok(result.url.includes('wikimedia'))
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should fall back to english wiki if localized returns 404', async () => {
      const originalFetch = globalThis.fetch
      let callCount = 0
      globalThis.fetch = mock.fn(async (url) => {
        callCount++
        if (url.includes('pt.wikipedia.org')) {
          return { ok: false }
        }
        if (url.includes('en.wikipedia.org')) {
          return {
            ok: true,
            json: async () => ({
              thumbnail: { source: 'https://upload.wikimedia.org/thumb/fallback.jpg' }
            })
          }
        }
        return { ok: false }
      })

      try {
        const result = await wikipedia().fetchIcon('bitcoin', 'pt')
        assert.ok(result)
        assert.ok(result.url.includes('fallback'))
        assert.ok(callCount >= 2, 'should have made at least 2 fetch calls')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should return null when no thumbnail exists', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ title: 'Test', extract: 'No image' })
      }))

      try {
        const result = await wikipedia().fetchIcon('some-obscure-tag', 'en')
        assert.equal(result, null)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe('Wikidata provider', () => {
    const wikidata = () => providers.find(p => p.name === 'wikidata')

    it('should return { url } when entity has P18 image claim (mocked)', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async (url) => {
        if (url.includes('wbsearchentities')) {
          return {
            ok: true,
            json: async () => ({
              search: [{ id: 'Q12345' }]
            })
          }
        }
        if (url.includes('wbgetclaims')) {
          return {
            ok: true,
            json: async () => ({
              claims: {
                P18: [{
                  mainsnak: {
                    datavalue: { value: 'Example image.jpg' }
                  }
                }]
              }
            })
          }
        }
        return { ok: false }
      })

      try {
        const result = await wikidata().fetchIcon('test', 'en')
        assert.ok(result)
        assert.ok(result.url.includes('commons.wikimedia.org'))
        assert.ok(result.url.includes('Example_image'))
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should return null when no entity found', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ search: [] })
      }))

      try {
        const result = await wikidata().fetchIcon('xyznonexistent', 'en')
        assert.equal(result, null)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe('DuckDuckGo provider', () => {
    const ddg = () => providers.find(p => p.name === 'duckduckgo')

    it('should return { url } when Image field exists (mocked)', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ Image: 'https://example.com/icon.png' })
      }))

      try {
        const result = await ddg().fetchIcon('pokemon', 'en')
        assert.ok(result)
        assert.equal(result.url, 'https://example.com/icon.png')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should handle relative Image paths', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ Image: '/i/test.png' })
      }))

      try {
        const result = await ddg().fetchIcon('test', 'en')
        assert.ok(result)
        assert.ok(result.url.startsWith('https://duckduckgo.com/'))
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should return null when no Image field', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ Abstract: 'Something', Image: '' })
      }))

      try {
        const result = await ddg().fetchIcon('test', 'en')
        assert.equal(result, null)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe('Google Favicon provider', () => {
    const favicon = () => providers.find(p => p.name === 'googleFavicon')

    it('should only try short alpha-only tags', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async () => ({
        ok: true,
        headers: new Map([['content-length', '2048']])
      }))

      try {
        // "hello world" has spaces — should return null without fetching
        const result = await favicon().fetchIcon('hello world', 'en')
        assert.equal(result, null)

        // "a-b" has dashes
        const result2 = await favicon().fetchIcon('a-b', 'en')
        assert.equal(result2, null)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should return { url } for a valid brand-like tag (mocked)', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async () => ({
        ok: true,
        headers: { get: () => '2048' }
      }))

      try {
        const result = await favicon().fetchIcon('github', 'en')
        assert.ok(result)
        assert.ok(result.url.includes('favicon'))
        assert.ok(result.url.includes('github'))
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should return null for the default globe icon size', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async () => ({
        ok: true,
        headers: { get: () => '726' }
      }))

      try {
        const result = await favicon().fetchIcon('xyzrand', 'en')
        assert.equal(result, null)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe('neighborIcon provider', () => {
    const neighborIconProvider = () => providers.find(p => p.name === 'neighborIcon')

    before(async () => {
      try {
        await mdb.createIndex('hashtagStats', { primaryKey: hashtagStatsSchema.primaryKey })
        await mdb.index('hashtagStats').updateSettings(hashtagStatsSchema.settings)
      } catch (_e) { /* already exists */ }
    })

    beforeEach(async () => {
      await mdb.index('hashtagStats').deleteAllDocuments()
    })

    after(() => {
      mock.restoreAll()
    })

    it('should return icon URL from nearest neighbor when stat provides neighbors', async () => {
      await mdb.index('hashtagStats').addDocuments([
        { key: 'en-crypto', lang: 'en', tag: 'crypto', count: 80, neighbors: [], statsUpdatedAt: Date.now(), icon: 'data:image/webp;base64,fakeicon' }
      ])

      const stat = { neighbors: [['crypto', 50], ['blockchain', 20]] }
      const result = await neighborIconProvider().fetchIcon('ethereum', 'en', stat)

      assert.ok(result)
      assert.equal(result.url, 'data:image/webp;base64,fakeicon')
    })

    it('should return null when no neighbor has a cached icon', async () => {
      await mdb.index('hashtagStats').addDocuments([
        { key: 'en-crypto', lang: 'en', tag: 'crypto', count: 80, neighbors: [], statsUpdatedAt: Date.now() }
      ])

      const stat = { neighbors: [['crypto', 50]] }
      const result = await neighborIconProvider().fetchIcon('ethereum', 'en', stat)
      assert.equal(result, null)
    })

    it('should return null when no neighbors exist', async () => {
      const result = await neighborIconProvider().fetchIcon('ethereum', 'en', { neighbors: [] })
      assert.equal(result, null)
    })

    it('should fetch topic doc from hashtagStats when stat has no neighbors', async () => {
      await mdb.index('hashtagStats').addDocuments([
        {
          key: 'en-ethereum',
          lang: 'en',
          tag: 'ethereum',
          count: 90,
          neighbors: [['crypto', 60]],
          statsUpdatedAt: Date.now()
        },
        {
          key: 'en-crypto',
          lang: 'en',
          tag: 'crypto',
          count: 80,
          neighbors: [],
          statsUpdatedAt: Date.now(),
          icon: 'data:image/webp;base64,neighboricon'
        }
      ])

      // No stat provided — should fall back to fetching the topic doc
      const result = await neighborIconProvider().fetchIcon('ethereum', 'en', undefined)
      assert.ok(result)
      assert.equal(result.url, 'data:image/webp;base64,neighboricon')
    })
  })

  describe('pollinations provider', () => {
    const pollinationsProvider = () => providers.find(p => p.name === 'pollinations')

    it('should have name and fetchIcon method', () => {
      assert.equal(typeof pollinationsProvider().fetchIcon, 'function')
    })

    it('should return {} (no url) when the client returns null (mocked)', async () => {
      const originalFetch = globalThis.fetch
      // Balance = 0 → client will bail early without calling the image endpoint
      globalThis.fetch = mock.fn(async (url) => {
        if (url.includes('/account/balance')) return { ok: true, json: async () => ({ balance: 0 }) }
        if (url.includes('/image/models')) {
          return {
            ok: true,
            json: async () => [
              { name: 'flux', paid_only: false, output_modalities: ['image'], pricing: { completionImageTokens: '0.001' } }
            ]
          }
        }
        return { ok: false, status: 503 }
      })

      try {
        // Must set a key so the client doesn't short-circuit on missing key
        process.env.POLLINATIONS_SECRET_KEY = 'sk_test'
        const result = await pollinationsProvider().fetchIcon('test', 'en', null)
        // {} means "no url" — resolver treats this the same as "no result"
        assert.ok(result !== null && typeof result === 'object')
        assert.equal(result.url, undefined)
      } finally {
        globalThis.fetch = originalFetch
        delete process.env.POLLINATIONS_SECRET_KEY
      }
    })

    it('should include neighbor terms in the prompt (verified via image URL, mocked)', async () => {
      const urlsSeen = []
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async (url) => {
        if (url.includes('/account/balance')) return { ok: true, json: async () => ({ balance: 0 }) }
        if (url.includes('/image/models')) {
          return {
            ok: true,
            json: async () => [
              { name: 'flux', paid_only: false, output_modalities: ['image'], pricing: { completionImageTokens: '0.001' } }
            ]
          }
        }
        urlsSeen.push(url)
        return { ok: false } // fail fast — we only care about the URL shape
      })

      try {
        process.env.POLLINATIONS_SECRET_KEY = 'sk_test'
        // Balance (0) < cheapest cost (0.001) → returns {} without hitting /image/ at all.
        // To reach the image URL we need a non-zero balance greater than the model cost.
        // Reset the models cache between tests.
        const { _resetModelsCache } = await import('#services/topic/pollinations-client.js')
        _resetModelsCache()

        // Use a balance high enough to attempt generation
        globalThis.fetch = mock.fn(async (url) => {
          if (url.includes('/account/balance')) return { ok: true, json: async () => ({ balance: 100 }) }
          if (url.includes('/image/models')) {
            return {
              ok: true,
              json: async () => [
                { name: 'flux', paid_only: false, output_modalities: ['image'], pricing: { completionImageTokens: '0.001' } }
              ]
            }
          }
          urlsSeen.push(url)
          return { ok: false }
        })

        const stat = { words: ['bit', 'coin'], neighbors: [['crypto', 80], ['blockchain', 60]] }
        await pollinationsProvider().fetchIcon('bitcoin', 'en', stat)
        _resetModelsCache()

        const decoded = decodeURIComponent(urlsSeen[0] || '')
        assert.ok(decoded.includes('crypto'), 'prompt should include neighbor term "crypto"')
        assert.ok(decoded.includes('blockchain'), 'prompt should include neighbor term "blockchain"')
      } finally {
        globalThis.fetch = originalFetch
        delete process.env.POLLINATIONS_SECRET_KEY
      }
    })
  })

  // -------------------------------------------------------------------------
  // Live API tests — each was run manually and confirmed to work, then
  // .skip was added so they don't burn quota / slow down CI automatically.
  // Remove .skip on any provider to re-verify after an API change.
  // -------------------------------------------------------------------------

  describe('Live API tests', () => {
    it.skip('Wikipedia: returns a thumbnail URL for "bitcoin"', async () => {
      const wp = providers.find(p => p.name === 'wikipedia')
      const result = await wp.fetchIcon('bitcoin', 'en')
      assert.ok(result, 'expected a result, got null')
      assert.ok(result.url.startsWith('http'), `expected http URL, got: ${result.url}`)
    })

    it.skip('Wikidata: returns a Commons image URL for "bitcoin"', async () => {
      const wd = providers.find(p => p.name === 'wikidata')
      const result = await wd.fetchIcon('bitcoin', 'en')
      // Bitcoin may or may not have a P18 claim — just verify the shape when present.
      if (result) {
        assert.ok(result.url.startsWith('http'), `expected http URL, got: ${result.url}`)
        assert.ok(result.url.includes('wikimedia.org') || result.url.includes('commons.wikimedia.org'))
      }
    })

    it.skip('DuckDuckGo: returns an image URL for "bitcoin"', async () => {
      const ddg = providers.find(p => p.name === 'duckduckgo')
      const result = await ddg.fetchIcon('bitcoin', 'en')
      assert.ok(result, 'expected a result, got null')
      assert.ok(result.url.startsWith('http'), `expected http URL, got: ${result.url}`)
    })

    it.skip('Google Favicon: returns a favicon URL for "github"', async () => {
      const favicon = providers.find(p => p.name === 'googleFavicon')
      const result = await favicon.fetchIcon('github', 'en')
      assert.ok(result, 'expected a result, got null')
      assert.ok(result.url.startsWith('http'), `expected http URL, got: ${result.url}`)
    })

    // Prefer the broader test at tests/services/topic/pollinations-client.test.js
    // it.skip('Pollinations: generates a data URL for "bitcoin" (requires POLLINATIONS_SECRET_KEY)', async () => {
    //   if (!process.env.POLLINATIONS_SECRET_KEY) return
    //   const prov = providers.find(p => p.name === 'pollinations')
    //   const stat = { words: ['bit', 'coin'], neighbors: [['crypto', 80]] }
    //   const result = await prov.fetchIcon('bitcoin', 'en', stat)
    //   // {} means insufficient balance — that is acceptable; { url } means success.
    //   assert.ok(result !== null && typeof result === 'object')
    //   if (result.url) {
    //     assert.ok(result.url.startsWith('data:image/webp;base64,'))
    //   }
    // })
  })
})
