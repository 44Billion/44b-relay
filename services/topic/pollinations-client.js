/**
 * Pollinations.ai client for AI image generation.
 *
 * Wraps gen.pollinations.ai with:
 *   - Model discovery (GET /image/models), filtered to non-paid image models,
 *     sorted by price ascending so the cheapest model is tried first.
 *   - Pollen balance check (GET /account/balance) before every generation
 *     attempt. If balance < cheapest model cost, returns null without calling
 *     the generation endpoint.
 *   - Sequential model fallback: if a model fails (network error, 5xx, …),
 *     the next cheapest model is tried automatically.
 *
 * Requires `process.env.POLLINATIONS_SECRET_KEY` (sk_… key).
 *
 * @see https://gen.pollinations.ai
 */
import { resizeImage, removeWhiteBackground } from '#services/topic/image-processor.js'

const BASE_URL = 'https://gen.pollinations.ai'
const TIMEOUT_MS = 4_000
const IMAGE_TIMEOUT_MS = 30_000
const MODELS_CACHE_TTL_MS = 60 * 60 * 1_000  // 1 hour

let _modelsCache = null
let _modelsCacheExpiry = 0

// --- helpers ----------------------------------------------------------------

function authHeaders () {
  return { Authorization: `Bearer ${process.env.POLLINATIONS_SECRET_KEY}` }
}

async function timedFetch (url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// --- public API -------------------------------------------------------------

/**
 * Returns the list of image-capable, non-paid-only models sorted by
 * completionImageTokens price ascending (cheapest first).
 * Results are cached for MODELS_CACHE_TTL_MS.
 *
 * @returns {Promise<object[]>}
 */
export async function getImageModels () {
  if (_modelsCache && Date.now() < _modelsCacheExpiry) return _modelsCache

  const res = await timedFetch(`${BASE_URL}/image/models`)
  if (!res.ok) return []

  const models = await res.json()
  _modelsCache = models
    .filter(m =>
      !m.paid_only &&
      Array.isArray(m.output_modalities) &&
      m.output_modalities.includes('image')
    )
    .sort((a, b) => {
      const ap = parseFloat(a.pricing?.completionImageTokens ?? '999')
      const bp = parseFloat(b.pricing?.completionImageTokens ?? '999')
      return ap - bp
    })
  _modelsCacheExpiry = Date.now() + MODELS_CACHE_TTL_MS
  return _modelsCache
}

/**
 * Returns the current pollen balance, or null if unavailable / key missing.
 *
 * @returns {Promise<number|null>}
 */
export async function getPollenBalance () {
  const key = process.env.POLLINATIONS_SECRET_KEY
  if (!key) return null

  try {
    const res = await timedFetch(`${BASE_URL}/account/balance`, { headers: authHeaders() })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data.balance === 'number' ? data.balance : null
  } catch {
    return null
  }
}

/**
 * Generates an icon image via the Pollinations API.
 *
 * Strategy:
 *   1. Fetch available models + current balance in parallel.
 *   2. If balance < cheapest model cost → return null (insufficient pollen).
 *   3. Try each model in ascending price order; move to next on any failure.
 *   4. On first success, resize to 512×512 webp and strip white background.
 *
 * Returns null (not an error throw) when:
 *   - No API key is configured.
 *   - Insufficient pollen balance.
 *   - All models fail.
 *
 * @param {string} prompt - Generation prompt.
 * @param {number} seed   - Deterministic seed (same tag → same image).
 * @returns {Promise<string|null>} webp data URL or null.
 */
export async function generatePollinationsImage (prompt, seed) {
  const key = process.env.POLLINATIONS_SECRET_KEY
  if (!key) return null

  const [models, balance] = await Promise.all([getImageModels(), getPollenBalance()])
  if (!models.length) return null

  if (balance !== null) {
    const cheapestCost = parseFloat(models[0].pricing?.completionImageTokens ?? '0')
    if (balance < cheapestCost) return null
  }

  for (const model of models) {
    const url = `${BASE_URL}/image/${encodeURIComponent(prompt)}?model=${model.name}&width=256&height=256&nologo=true&seed=${seed}`
    try {
      const res = await timedFetch(url, { headers: authHeaders() }, IMAGE_TIMEOUT_MS)
      if (!res.ok) continue

      const buf = Buffer.from(await res.arrayBuffer())
      const resized = await resizeImage({ input: buf, resizeOptions: { width: 512, height: 512 } })
      const transparent = await removeWhiteBackground(resized)
      return `data:image/webp;base64,${transparent.toString('base64')}`
    } catch {
      // try next model
    }
  }

  return null
}

/** Resets the models cache (used in tests). */
export function _resetModelsCache () {
  _modelsCache = null
  _modelsCacheExpiry = 0
}

export { BASE_URL, TIMEOUT_MS, IMAGE_TIMEOUT_MS, MODELS_CACHE_TTL_MS }
