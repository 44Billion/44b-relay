/**
 * Icon Resolver — orchestrates multiple icon providers with:
 *   - Ordered fallback (try providers in sequence)
 *   - Per-provider health tracking via MeiliSearch (`iconProviderHealth` index)
 *   - Exponential backoff for repeatedly-failing providers
 *   - Concurrency control (resolve icons for a batch of tags in parallel
 *     with bounded concurrency so we don't hammer APIs)
 *
 * The resolved icon URL is stored in the `icon` field of the hashtagStats
 * document and propagated to the `icon` tag of the kind 30385 event.
 */
import mdb from '#services/db/mdb.js'
import { providers } from '#services/topic/icon-providers.js'
import { processImage } from '#services/topic/image-processor.js'

// --- Backoff constants ---
const BASE_BACKOFF_MS = 5 * 60 * 1000           // 5 minutes
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000      // 24 hours
const FAILURES_BEFORE_BACKOFF = 3                // allow 3 consecutive fails before backoff
const CONCURRENCY = 3                            // max concurrent icon fetches
// Clear a stale lastError if the provider hasn't failed for at least this long
const ERROR_CLEAR_AFTER_MS = 24 * 60 * 60 * 1000 // 24 hours

// --- In-memory health cache (warmed from MeiliSearch on first use) ---
// Map<providerName, { consecutiveFailures, backoffUntil, ... }>
let healthCache = null

/**
 * Warms the in-memory health cache from MeiliSearch.
 * Called lazily on the first resolveIcon call per process lifetime.
 */
async function warmHealthCache () {
  if (healthCache) return
  healthCache = new Map()

  try {
    const { hits } = await mdb.index('iconProviderHealth').search('', {
      limit: 20
    })
    for (const doc of hits) {
      healthCache.set(doc.name, doc)
    }
  } catch (err) {
    if (err.code !== 'index_not_found' && err.cause?.code !== 'index_not_found') {
      console.error('Failed to warm icon provider health cache:', err)
    }
  }
}

/**
 * Returns the current health record for a provider (from cache).
 * Never null — creates a default record if missing.
 */
function getHealth (providerName) {
  if (!healthCache.has(providerName)) {
    healthCache.set(providerName, {
      name: providerName,
      consecutiveFailures: 0,
      backoffUntil: 0,
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      totalSuccesses: 0,
      totalFailures: 0
    })
  }
  return healthCache.get(providerName)
}

/**
 * Records a success for the given provider.
 * Clears lastError/erroredAt if the error is old enough.
 */
async function recordSuccess (providerName) {
  const h = getHealth(providerName)
  h.consecutiveFailures = 0
  h.backoffUntil = 0
  h.lastAttemptAt = Date.now()
  h.lastSuccessAt = Date.now()
  h.totalSuccesses = (h.totalSuccesses || 0) + 1

  // Clear stale lastError: if the error happened more than ERROR_CLEAR_AFTER_MS ago,
  // treat this run as a clean slate.
  if (h.erroredAt && (Date.now() - h.erroredAt) >= ERROR_CLEAR_AFTER_MS) {
    h.lastError = null
    h.erroredAt = null
  }

  await persistHealth(h)
}

/**
 * Records a failure for the given provider and computes exponential backoff.
 * Stores the error message/stack on the health record.
 *
 * @param {string} providerName
 * @param {Error|null} [err] - optional error object for `lastError` tracking
 */
async function recordFailure (providerName, err) {
  const h = getHealth(providerName)
  h.consecutiveFailures = (h.consecutiveFailures || 0) + 1
  h.lastAttemptAt = Date.now()
  h.totalFailures = (h.totalFailures || 0) + 1

  if (err) {
    h.lastError = ((err.stack || err.message || String(err)).slice(0, 1000))
    h.erroredAt = Date.now()
  }

  if (h.consecutiveFailures >= FAILURES_BEFORE_BACKOFF) {
    const exponent = h.consecutiveFailures - FAILURES_BEFORE_BACKOFF
    const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, exponent), MAX_BACKOFF_MS)
    h.backoffUntil = Date.now() + backoffMs
  }

  await persistHealth(h)
}

/**
 * Persists a single health record to MeiliSearch (fire-and-forget-ish).
 */
async function persistHealth (record) {
  try {
    await mdb.index('iconProviderHealth').addDocuments([{ ...record }])
  } catch (err) {
    console.error(`Failed to persist icon provider health for ${record.name}:`, err)
  }
}

/**
 * Checks whether a provider is currently backed off.
 */
function isBackedOff (providerName) {
  const h = healthCache?.get(providerName)
  if (!h || !h.backoffUntil) return false
  return Date.now() < h.backoffUntil
}

/**
 * Resolves an icon URL for a single tag.
 *
 * Tries each provider in order, skipping backed-off ones.
 * Returns `{ url }` on the first successful result, or `null`.
 *
 * @param {string} tag - normalized hashtag
 * @param {string} lang - ISO 639-1 language code
 * @param {object} [stat] - optional full hashtagStats document for context-aware providers
 * @returns {Promise<{ url: string } | null>}
 */
export async function resolveIcon (tag, lang, stat) {
  await warmHealthCache()

  for (const provider of providers) {
    if (isBackedOff(provider.name)) continue

    try {
      const result = await provider.fetchIcon(tag, lang, stat)
      if (result?.url) {
        await recordSuccess(provider.name)
        return result
      }
      // Provider returned null (no match) — this is not a failure,
      // just means no icon was found for this specific tag.
      // We do NOT record a failure for this.
    } catch (err) {
      // Network error, timeout, parse error, etc. — count as failure.
      await recordFailure(provider.name, err)
    }
  }

  return null
}

/**
 * Resolves icons for a batch of tags with bounded concurrency.
 *
 * @param {{ tag: string, lang: string, stat?: object }[]} items
 *   `stat` is the optional full hashtagStats document; forwarded to providers
 *   that can use words/neighbors for richer lookups or prompt construction.
 * @returns {Promise<Map<string, string>>} tag → icon data URL
 */
export async function resolveIconsBatch (items) {
  await warmHealthCache()

  const results = new Map()
  let idx = 0

  async function worker () {
    while (idx < items.length) {
      const i = idx++
      const { tag, lang, stat } = items[i]
      try {
        const result = await resolveIcon(tag, lang, stat)
        if (result?.url) {
          // Some providers (neighborIcon, pollinations) already return a data URL —
          // skip processImage since the image is already resized and encoded.
          const iconDataUrl = result.url.startsWith('data:')
            ? result.url
            : await processImage(result.url)
          results.set(tag, iconDataUrl)
        }
      } catch (err) {
        console.warn(`Failed to resolve/process icon for tag "${tag}":`, err)
        // Swallow — individual tag failure shouldn't crash the batch
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, items.length) },
    () => worker()
  )
  await Promise.all(workers)

  return results
}

/**
 * Resets the in-memory health cache (used in tests).
 */
export function _resetHealthCache () {
  healthCache = null
}

export {
  FAILURES_BEFORE_BACKOFF,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  CONCURRENCY,
  ERROR_CLEAR_AFTER_MS,
  warmHealthCache,
  isBackedOff,
  recordSuccess,
  recordFailure
}
