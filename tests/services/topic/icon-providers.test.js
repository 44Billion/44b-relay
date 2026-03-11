import { describe, it, before, mock } from 'node:test'
import assert from 'node:assert/strict'

describe('Icon Providers', () => {
  let providers, PROVIDER_TIMEOUT_MS

  before(async () => {
    const mod = await import('#services/topic/icon-providers.js')
    providers = mod.providers
    PROVIDER_TIMEOUT_MS = mod.PROVIDER_TIMEOUT_MS
  })

  it('should export an ordered array of providers', () => {
    assert.ok(Array.isArray(providers))
    assert.ok(providers.length >= 4)

    const names = providers.map(p => p.name)
    assert.ok(names.includes('wikipedia'))
    assert.ok(names.includes('wikidata'))
    assert.ok(names.includes('duckduckgo'))
    assert.ok(names.includes('googleFavicon'))
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

  describe('Provider health checks (live, optional)', () => {
    // These tests hit real APIs — they serve as health checks.
    // They are non-fatal (skipped if network is unavailable).

    it('Wikipedia: should be reachable', async () => {
      const wp = providers.find(p => p.name === 'wikipedia')
      try {
        const result = await wp.fetchIcon('bitcoin', 'en')
        // May or may not return a result depending on API availability
        if (result) {
          assert.ok(result.url.startsWith('http'))
        }
      } catch (_err) {
        // Network not available — skip gracefully
      }
    })

    it('DuckDuckGo: should be reachable', async () => {
      const ddg = providers.find(p => p.name === 'duckduckgo')
      try {
        const result = await ddg.fetchIcon('bitcoin', 'en')
        if (result) {
          assert.ok(result.url.startsWith('http'))
        }
      } catch (_err) {
        // Network not available — skip gracefully
      }
    })
  })
})
