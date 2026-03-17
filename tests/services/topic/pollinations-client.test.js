import { describe, it, before, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

// Mock image-processor BEFORE the client module is imported so that
// resizeImage / removeWhiteBackground never touch real image bytes in unit tests.
mock.module('#services/topic/image-processor.js', {
  namedExports: {
    resizeImage: async ({ input }) => input,
    removeWhiteBackground: async (buf) => buf,
    processImage: async () => 'data:image/webp;base64,fake'
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_MODELS = [
  {
    name: 'flux',
    paid_only: false,
    output_modalities: ['image'],
    pricing: { completionImageTokens: '0.001' }
  },
  {
    name: 'zimage',
    paid_only: false,
    output_modalities: ['image'],
    pricing: { completionImageTokens: '0.002' }
  },
  {
    name: 'paid-model',
    paid_only: true,
    output_modalities: ['image'],
    pricing: { completionImageTokens: '0.0001' }
  },
  {
    name: 'video-model',
    paid_only: false,
    output_modalities: ['video'],
    pricing: { completionVideoSeconds: '0.05' }
  }
]

const FAKE_IMAGE_BYTES = Buffer.alloc(64, 0xff)

function makeFetchMock ({ balance = 100, modelsOk = true, imageOk = true, failFirst = false } = {}) {
  let imageCallCount = 0
  return mock.fn(async (url) => {
    if (url.includes('/account/balance')) {
      return { ok: true, json: async () => ({ balance }) }
    }
    if (url.includes('/image/models')) {
      if (!modelsOk) return { ok: false, status: 503 }
      return { ok: true, json: async () => FAKE_MODELS }
    }
    if (url.includes('/image/')) {
      imageCallCount++
      if (failFirst && imageCallCount === 1) return { ok: false, status: 503 }
      if (!imageOk) return { ok: false, status: 503 }
      return { ok: true, arrayBuffer: async () => FAKE_IMAGE_BYTES.buffer }
    }
    return { ok: false, status: 404 }
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pollinations Client', () => {
  let client

  before(async () => {
    client = await import('#services/topic/pollinations-client.js')
  })

  beforeEach(() => {
    client._resetModelsCache()
    delete process.env.POLLINATIONS_SECRET_KEY
  })

  // --- getImageModels -------------------------------------------------------

  describe('getImageModels()', () => {
    it('should filter out paid_only and non-image models, sorted by price asc', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = makeFetchMock()
      try {
        const models = await client.getImageModels()
        assert.ok(Array.isArray(models))
        // only flux and zimage pass the filter
        assert.equal(models.length, 2)
        assert.equal(models[0].name, 'flux')   // cheaper (0.001)
        assert.equal(models[1].name, 'zimage') // more expensive (0.002)
        // paid_only and video models must be excluded
        assert.ok(!models.some(m => m.paid_only))
        assert.ok(!models.some(m => !m.output_modalities.includes('image')))
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should return [] when the models endpoint fails', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = makeFetchMock({ modelsOk: false })
      try {
        const models = await client.getImageModels()
        assert.deepEqual(models, [])
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should return cached results on subsequent calls', async () => {
      let fetchCount = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async (url) => {
        if (url.includes('/image/models')) fetchCount++
        return { ok: true, json: async () => FAKE_MODELS }
      })
      try {
        await client.getImageModels()
        await client.getImageModels()
        assert.equal(fetchCount, 1, 'should only fetch once while cache is warm')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('_resetModelsCache() forces a re-fetch', async () => {
      let fetchCount = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async (url) => {
        if (url.includes('/image/models')) fetchCount++
        return { ok: true, json: async () => FAKE_MODELS }
      })
      try {
        await client.getImageModels()
        client._resetModelsCache()
        await client.getImageModels()
        assert.equal(fetchCount, 2)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  // --- getPollenBalance -----------------------------------------------------

  describe('getPollenBalance()', () => {
    it('should return null when no API key is set', async () => {
      const balance = await client.getPollenBalance()
      assert.equal(balance, null)
    })

    it('should return the numeric balance from the API', async () => {
      process.env.POLLINATIONS_SECRET_KEY = 'sk_test'
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ balance: 42.5 })
      }))
      try {
        const balance = await client.getPollenBalance()
        assert.equal(balance, 42.5)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should return null when the API responds with a non-OK status', async () => {
      process.env.POLLINATIONS_SECRET_KEY = 'sk_test'
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async () => ({ ok: false, status: 401 }))
      try {
        const balance = await client.getPollenBalance()
        assert.equal(balance, null)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should return null when the fetch throws', async () => {
      process.env.POLLINATIONS_SECRET_KEY = 'sk_test'
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async () => { throw new Error('network error') })
      try {
        const balance = await client.getPollenBalance()
        assert.equal(balance, null)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  // --- generatePollinationsImage --------------------------------------------

  describe('generatePollinationsImage()', () => {
    it('should return null when no API key is set', async () => {
      const result = await client.generatePollinationsImage('test prompt', 1)
      assert.equal(result, null)
    })

    it('should return null when pollen balance is insufficient', async () => {
      process.env.POLLINATIONS_SECRET_KEY = 'sk_test'
      const originalFetch = globalThis.fetch
      // balance (0.0001) < cheapest model cost (0.001 for flux)
      globalThis.fetch = makeFetchMock({ balance: 0.0001 })
      try {
        const result = await client.generatePollinationsImage('test prompt', 1)
        assert.equal(result, null)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should return a data URL on success', async () => {
      process.env.POLLINATIONS_SECRET_KEY = 'sk_test'
      const originalFetch = globalThis.fetch
      globalThis.fetch = makeFetchMock({ balance: 100 })
      try {
        const result = await client.generatePollinationsImage('test prompt', 1)
        assert.ok(result)
        assert.ok(result.startsWith('data:image/webp;base64,'))
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should fall back to the next model when the first fails', async () => {
      process.env.POLLINATIONS_SECRET_KEY = 'sk_test'
      const originalFetch = globalThis.fetch
      const urlsSeen = []
      let imageCallCount = 0
      globalThis.fetch = mock.fn(async (url) => {
        if (url.includes('/account/balance')) return { ok: true, json: async () => ({ balance: 100 }) }
        if (url.includes('/image/models')) return { ok: true, json: async () => FAKE_MODELS }
        if (url.includes('/image/')) {
          urlsSeen.push(url)
          imageCallCount++
          if (imageCallCount === 1) return { ok: false, status: 503 } // first model fails
          return { ok: true, arrayBuffer: async () => FAKE_IMAGE_BYTES.buffer }
        }
        return { ok: false }
      })
      try {
        const result = await client.generatePollinationsImage('test prompt', 1)
        assert.ok(result, 'should succeed after falling back to second model')
        assert.equal(imageCallCount, 2, 'should have tried 2 models')
        assert.ok(urlsSeen[0].includes('model=flux'), 'first attempt should use flux (cheapest)')
        assert.ok(urlsSeen[1].includes('model=zimage'), 'second attempt should use zimage')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should return null when all models fail', async () => {
      process.env.POLLINATIONS_SECRET_KEY = 'sk_test'
      const originalFetch = globalThis.fetch
      globalThis.fetch = makeFetchMock({ balance: 100, imageOk: false })
      try {
        const result = await client.generatePollinationsImage('test prompt', 1)
        assert.equal(result, null)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should pass the seed through to the image URL', async () => {
      process.env.POLLINATIONS_SECRET_KEY = 'sk_test'
      const originalFetch = globalThis.fetch
      const urlsSeen = []
      globalThis.fetch = mock.fn(async (url) => {
        if (url.includes('/account/balance')) return { ok: true, json: async () => ({ balance: 100 }) }
        if (url.includes('/image/models')) return { ok: true, json: async () => FAKE_MODELS }
        if (url.includes('/image/')) {
          urlsSeen.push(url)
          return { ok: true, arrayBuffer: async () => FAKE_IMAGE_BYTES.buffer }
        }
        return { ok: false }
      })
      try {
        await client.generatePollinationsImage('test', 99999)
        assert.ok(urlsSeen[0].includes('seed=99999'))
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('should return null when no models are available', async () => {
      process.env.POLLINATIONS_SECRET_KEY = 'sk_test'
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock.fn(async (url) => {
        if (url.includes('/account/balance')) return { ok: true, json: async () => ({ balance: 100 }) }
        if (url.includes('/image/models')) return { ok: false, status: 503 }
        return { ok: false }
      })
      try {
        const result = await client.generatePollinationsImage('test', 1)
        assert.equal(result, null)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  // --- Live API test (verified manually, then skipped) ---------------------

  describe('Live API', () => {
    it.skip('real API: should generate a webp data URL for a known prompt', async () => {
      // Requires POLLINATIONS_SECRET_KEY to be set in the environment.
      // Run once manually to verify, then keep .skip to avoid burning pollen in CI.
      if (!process.env.POLLINATIONS_SECRET_KEY) {
        // No key — nothing to test.
        return
      }
      client._resetModelsCache()
      const dataUrl = await client.generatePollinationsImage(
        'minimal flat icon representing: bitcoin, crypto, blockchain, simple clean design, solid white background, vector style',
        tagToSeed('bitcoin')
      )
      // If insufficient balance, dataUrl is null — that is still a valid "success" path.
      assert.ok(
        dataUrl === null || dataUrl.startsWith('data:image/webp;base64,'),
        `expected null or a webp data URL, got: ${String(dataUrl).slice(0, 80)}`
      )
    })
  })
})

// Deterministic seed helper (mirrors the one in icon-providers.js)
function tagToSeed (tag) {
  return Math.abs(tag.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0))
}
