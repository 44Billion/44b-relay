/**
 * Icon providers for topic hashtags.
 *
 * Each provider exposes:
 *   - name: unique identifier
 *   - fetchIcon(tag, lang, stat?): returns { url: string } or null
 *     `stat` is the full hashtagStats document (optional), giving providers
 *     access to words and neighbors for richer lookups or prompt construction.
 *     Providers that don't need it simply ignore the parameter.
 *
 * All network calls use AbortController with a per-provider timeout
 * so a slow API never blocks the job pipeline.
 *
 * Wikipedia language prefixes:
 * @see https://meta.wikimedia.org/wiki/List_of_Wikipedias
 */
import mdb from '#services/db/mdb.js'
import { generatePollinationsImage } from '#services/topic/pollinations-client.js'

const PROVIDER_TIMEOUT_MS = 4000

// --- helpers ---------------------------------------------------------------

/**
 * Performs a fetch with a per-call timeout.
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<Response>}
 */
async function timedFetch (url, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * ISO 639-1 → Wikipedia subdomain.  Only the largest Wikipedias are mapped;
 * others fall back to English.
 */
const WIKI_LANG_MAP = {
  en: 'en', pt: 'pt', es: 'es', fr: 'fr', de: 'de', it: 'it',
  ja: 'ja', ko: 'ko', zh: 'zh', ru: 'ru', ar: 'ar', nl: 'nl',
  sv: 'sv', pl: 'pl', tr: 'tr', id: 'id', uk: 'uk', he: 'he',
  cs: 'cs', fi: 'fi', no: 'no', da: 'da', ro: 'ro', hu: 'hu',
  el: 'el', th: 'th', vi: 'vi', ca: 'ca', hi: 'hi', bn: 'bn'
}

function wikiSubdomain (lang) {
  return WIKI_LANG_MAP[lang] || 'en'
}

// --- providers -------------------------------------------------------------

/**
 * 1. Wikipedia REST API (page summary)
 *
 * Returns the page thumbnail URL if the topic matches a page.
 * Localized by language; falls back to English if nothing found.
 * Rate: generous (200 req/s with polite User-Agent).
 * @see https://en.wikipedia.org/api/rest_v1/#/Page%20content/get_page_summary__title_
 */
const wikipedia = {
  name: 'wikipedia',

  async fetchIcon (tag, lang) {
    const sub = wikiSubdomain(lang)
    const url = `https://${sub}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(tag)}`

    const res = await timedFetch(url, {
      headers: { 'Api-User-Agent': '44b-relay/1.0 (nostr relay; topic icons)' }
    })

    if (!res.ok) {
      // Try English fallback if the localized wiki had nothing
      if (sub !== 'en') {
        const fallbackUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(tag)}`
        const fallbackRes = await timedFetch(fallbackUrl, {
          headers: { 'Api-User-Agent': '44b-relay/1.0 (nostr relay; topic icons)' }
        })
        if (!fallbackRes.ok) return null
        const data = await fallbackRes.json()
        return extractWikiThumbnail(data)
      }
      return null
    }

    const data = await res.json()
    return extractWikiThumbnail(data)
  }
}

function extractWikiThumbnail (data) {
  const src = data?.thumbnail?.source
  if (!src) return null
  return { url: src }
}

/**
 * 2. Wikidata entity image (P18 claim)
 *
 * Searches Wikidata for an entity matching the tag, then fetches the
 * main image (P18 property).  Good for proper nouns that have Wikidata entries.
 * @see https://www.wikidata.org/w/api.php
 */
const wikidata = {
  name: 'wikidata',

  async fetchIcon (tag, lang) {
    const searchLang = WIKI_LANG_MAP[lang] ? lang : 'en'
    const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(tag)}&language=${searchLang}&format=json&limit=1&origin=*`

    const searchRes = await timedFetch(searchUrl)
    if (!searchRes.ok) return null

    const searchData = await searchRes.json()
    const entityId = searchData?.search?.[0]?.id
    if (!entityId) return null

    // Fetch entity claims
    const entityUrl = `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${entityId}&property=P18&format=json&origin=*`
    const entityRes = await timedFetch(entityUrl)
    if (!entityRes.ok) return null

    const entityData = await entityRes.json()
    const imageClaim = entityData?.claims?.P18?.[0]
    const imageFile = imageClaim?.mainsnak?.datavalue?.value
    if (!imageFile) return null

    // Construct Wikimedia Commons thumb URL
    const encodedFile = encodeURIComponent(imageFile.replace(/ /g, '_'))
    const thumbUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodedFile}?width=64`
    return { url: thumbUrl }
  }
}

/**
 * 3. DuckDuckGo Instant Answer API
 *
 * Returns the "Image" field from DDG's instant answer box.
 * Free, no key needed.
 * @see https://api.duckduckgo.com/api
 */
const duckduckgo = {
  name: 'duckduckgo',

  async fetchIcon (tag, _lang) {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(tag)}&format=json&no_html=1&skip_disambig=1`

    const res = await timedFetch(url)
    if (!res.ok) return null

    const data = await res.json()
    const image = data?.Image
    if (!image) return null

    // DDG may return relative paths
    const absoluteUrl = image.startsWith('http') ? image : `https://duckduckgo.com${image}`
    return { url: absoluteUrl }
  }
}

/**
 * 4. Google Favicon (brand guess)
 *
 * If the topic could be a brand/website name, try fetching its favicon.
 * E.g. "github" → github.com favicon.
 * @see https://www.google.com/s2/favicons?sz=64&domain=<domain>
 */
const googleFavicon = {
  name: 'googleFavicon',

  async fetchIcon (tag, _lang) {
    // Only try short, single-word, alpha-only tags (likely brand names)
    if (tag.length > 20 || !/^[a-z0-9]+$/.test(tag)) return null

    const url = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(tag)}.com`

    const res = await timedFetch(url)
    if (!res.ok) return null

    // Google returns a default globe icon for unknown domains.
    // We can detect this by checking content-length — the default is ~726 bytes.
    // Real favicons are usually either much smaller (< 100 bytes for simple) or
    // much larger (> 1000 bytes for high-res). The default globe 32x32 is ~726.
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10)
    if (contentLength > 0 && contentLength < 800 && contentLength > 600) {
      // Likely the default globe icon; skip
      return null
    }

    // The URL itself is the icon (hotlink)
    return { url }
  }
}

/**
 * 5. Neighbor icon fallback
 *
 * Looks up co-occurring neighbor tags (from the stat doc or fetched from
 * hashtagStats) and returns the first one that already has a cached icon.
 * Zero external requests — pure MeiliSearch lookups.
 */
const neighborIcon = {
  name: 'neighborIcon',

  async fetchIcon (tag, lang, stat) {
    let neighborTags = (stat?.neighbors || []).slice(0, 5).map(([t]) => t)

    if (neighborTags.length === 0) {
      try {
        const doc = await mdb.index('hashtagStats').getDocument(`${lang}-${tag}`)
        neighborTags = (doc.neighbors || []).slice(0, 5).map(([t]) => t)
      } catch {
        return null
      }
    }

    if (neighborTags.length === 0) return null

    const docs = await Promise.all(
      neighborTags.map(t =>
        mdb.index('hashtagStats').getDocument(`${lang}-${t}`).catch(() => null)
      )
    )

    for (const doc of docs) {
      if (doc?.icon) return { url: doc.icon }
    }
    return null
  }
}

// --- Pollinations.ai helpers -----------------------------------------------

function buildPollinationsPrompt (tag, stat) {
  const words = stat?.words?.length ? stat.words : [tag]
  const neighborTerms = (stat?.neighbors || []).slice(0, 3).map(([t]) => t)
  const terms = [...new Set([...words, ...neighborTerms])].join(', ')
  return `minimal flat icon representing: ${terms}, simple clean design, solid white background, vector style`
}

function tagToSeed (tag) {
  return Math.abs(tag.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0))
}

/**
 * 6. Pollinations.ai AI image generation
 *
 * Last-resort fallback for topics with no icon anywhere else.
 * Delegates to pollinations-client which handles model selection,
 * pollen balance checking, and sequential model fallback.
 *
 * Returns {} (no url) when pollen is insufficient — the resolver treats
 * this the same as "no result" without counting it as a failure.
 *
 * @see https://gen.pollinations.ai
 */
const pollinations = {
  name: 'pollinations',

  async fetchIcon (tag, _lang, stat) {
    const prompt = buildPollinationsPrompt(tag, stat)
    const seed = tagToSeed(tag)
    const dataUrl = await generatePollinationsImage(prompt, seed)
    if (!dataUrl) return {}
    return { url: dataUrl }
  }
}

/**
 * Ordered list of all providers.  The resolver tries them in this order,
 * skipping any that are currently backed off.
 */
export const providers = [
  wikipedia,
  wikidata,
  duckduckgo,
  googleFavicon,
  neighborIcon,
  pollinations
]

export { PROVIDER_TIMEOUT_MS }
