/**
 * Hashtag extraction, normalization, word splitting, and acronym derivation
 * for Nostr event topic detection.
 */
import { newStemmer } from 'snowball-stemmers'
import { LanguageModel, SUPPORTED_LANGUAGES } from '#lib/wordninja/index.js'

const MAX_TAG_LENGTH = 80
const MIN_TAG_LENGTH = 2

// Lazily loaded wordninja LanguageModel instances, one per language code.
const wordninjaModels = new Map()

function getWordninjaModel (language) {
  const lang = SUPPORTED_LANGUAGES.includes(language) ? language : 'en'
  if (!wordninjaModels.has(lang)) {
    wordninjaModels.set(lang, new LanguageModel({ language: lang }))
  }
  return wordninjaModels.get(lang)
}

// ISO 639-1 → Snowball language name; lazily cached stemmer instances
const ISO_TO_SNOWBALL = {
  ar: 'arabic', da: 'danish', nl: 'dutch', en: 'english',
  fi: 'finnish', fr: 'french', de: 'german', el: 'greek',
  hu: 'hungarian', it: 'italian', no: 'norwegian', pt: 'portuguese',
  ro: 'romanian', ru: 'russian', es: 'spanish', sv: 'swedish', tr: 'turkish'
}
const stemmers = new Map()

/**
 * Extracts and normalizes hashtags from a Nostr event's `t` tags.
 * Returns an array of { tag, typed, words, acronym } objects, deduplicated.
 *
 * @param {object} event - Nostr event with `tags` array
 * @param {object} [options]
 * @param {string} [options.language] - ISO 639-1 language code used as hint for wordninja splitting
 * @returns {{ tag: string, typed: string|null, words: string[], acronym: string|null }[]}
 */
export function extractHashtags (event, { language } = {}) {
  if (!event?.tags?.length) return []

  const seen = new Set()
  const results = []

  for (const t of event.tags) {
    if (t[0] !== 't' || !t[1]) continue

    const normalized = normalizeTag(t[1])
    if (!normalized || seen.has(normalized)) continue

    seen.add(normalized)

    // Prefer typed form (third element) for word splitting if available
    const typed = t[2] && typeof t[2] === 'string' ? t[2].trim() : null
    const words = splitTagIntoWords(typed || t[1], { language })
    const acronym = deriveAcronym(words)

    results.push({ tag: normalized, typed, words, acronym })
  }

  return results
}

/**
 * Normalizes a hashtag value: lowercase, trim, strip leading '#',
 * remove internal spaces, reject noisy values.
 *
 * @param {string} raw
 * @returns {string|null} normalized tag or null if invalid
 */
export function normalizeTag (raw) {
  if (!raw || typeof raw !== 'string') return null

  let tag = raw.trim().toLowerCase()
  if (tag.startsWith('#')) tag = tag.slice(1)
  // Collapse internal spaces (some clients put spaces in the normalized value)
  tag = tag.replace(/\s+/g, '')

  if (tag.length < MIN_TAG_LENGTH || tag.length > MAX_TAG_LENGTH) return null
  if (/^\d+$/.test(tag)) return null // all digits
  if (/(.)\1{4,}/.test(tag)) return null // 5+ repeated chars

  return tag
}

// camelCase / PascalCase boundary: a lowercase followed by an uppercase,
// or a sequence of uppercase letters followed by an uppercase + lowercase
// (e.g. "HTMLParser" → "HTML", "Parser")
const CAMEL_SPLIT_REGEX = /([a-z])([A-Z])|([A-Z]+)([A-Z][a-z])/g

/**
 * Splits a hashtag (preferably the typed form) into its constituent words.
 * Supports camelCase, PascalCase, dashes, underscores, spaces, and — as a
 * last resort — probabilistic word splitting via wordninja for joined text
 * such as 'derekanderson' or 'wiegehtesdir'.
 *
 * @param {string} input - raw or typed hashtag value
 * @param {object} [options]
 * @param {string} [options.language] - ISO 639-1 hint passed to wordninja
 * @returns {string[]} lowercase words
 */
export function splitTagIntoWords (input, { language } = {}) {
  if (!input || typeof input !== 'string') return []

  // Replace dashes and underscores with spaces
  let s = input.replace(/[-_]/g, ' ')

  // Split camelCase / PascalCase boundaries
  s = s.replace(CAMEL_SPLIT_REGEX, (_, p1, p2, p3, p4) => {
    if (p1) return `${p1} ${p2}`
    return `${p3} ${p4}`
  })

  const words = s
    .split(/\s+/)
    .map(w => w.toLowerCase().trim())
    .filter(w => w.length > 0)

  // If explicit structural boundaries were found, we're done.
  if (words.length > 1) return words

  // No boundaries – try wordninja to detect word boundaries in joined text.
  const base = words[0] ?? input.toLowerCase()
  const ninjaWords = getWordninjaModel(language).split(base).filter(w => /\S/.test(w))
  return ninjaWords.length > 1 ? ninjaWords : (words.length > 0 ? words : [input.toLowerCase()])
}

/**
 * Derives an acronym from split words.
 * E.g. ['a', 'hashtag', 'example'] → 'ahe'
 * Returns null if conditions aren't met (< 2 words or acronym too short/long).
 *
 * @param {string[]} words
 * @returns {string|null}
 */
export function deriveAcronym (words) {
  if (!words || words.length < 2) return null
  const acronym = words.map(w => w[0]).join('')
  if (acronym.length < 2 || acronym.length > 6) return null
  return acronym
}

/**
 * Gets (or creates and caches) a Snowball stemmer for the given ISO 639-1 language.
 * Returns null if the language is not supported.
 *
 * @param {string|undefined} lang - ISO 639-1 code
 * @returns {object|null}
 */
function getStemmer (lang) {
  if (!lang) return null
  const snowballLang = ISO_TO_SNOWBALL[lang]
  if (!snowballLang) return null
  if (!stemmers.has(lang)) stemmers.set(lang, newStemmer(snowballLang))
  return stemmers.get(lang)
}

/**
 * Checks if two tags are likely morphological synonyms (inflectional variants).
 * Uses Snowball stemming for supported languages, falling back to a prefix-based
 * heuristic for unknown languages.
 * E.g. sport/sports (en), esporte/esportes (pt), deporte/deportes (es)
 *
 * @param {string} a - normalized tag
 * @param {string} b - normalized tag
 * @param {string} [lang] - ISO 639-1 language code (optional; enables Snowball stemming)
 * @returns {boolean}
 */
export function areMorphologicalSynonyms (a, b, lang) {
  if (a === b) return false

  const stemmer = getStemmer(lang)
  if (stemmer) {
    return stemmer.stem(a) === stemmer.stem(b)
  }

  // Fallback: prefix-based heuristic for unsupported languages
  if (a.length > b.length) [a, b] = [b, a]

  const minPrefix = Math.ceil(a.length * 0.7)
  let shared = 0
  while (shared < a.length && a[shared] === b[shared]) shared++
  if (shared < minPrefix) return false

  // Require the remaining suffix difference to be small (max 4 chars)
  const suffixDiff = (b.length - shared) - (a.length - shared)
  return suffixDiff >= 0 && suffixDiff <= 4 && (b.length - a.length) <= 4
}
