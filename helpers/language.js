import lande from 'lande'
import { franc } from 'franc'
import { iso6393To1 } from 'iso-639-3'
import { eventKinds } from '#constants/event.js'

const MIN_ALPHA_CHARS = 10
const LANDE_MIN_CONFIDENCE = 0.55

const kindsUsingContent = new Set([
  eventKinds.TEXT_NOTE,
  eventKinds.LONG_FORM_CONTENT
])

const kindsUsingContentOrTitle = new Set([
  eventKinds.PICTURE,
  eventKinds.VIDEO,
  eventKinds.SHORT_VIDEO,
  eventKinds.EDITABLE_VIDEO,
  eventKinds.EDITABLE_SHORT_VIDEO
])

// --- Sanitization regexes ---

// NIP-19 entities optionally prefixed with nostr: (NIP-21)
const NIP19_REGEX = /(?:nostr:)?(?:npub|nsec|note|nprofile|nevent|naddr|nrelay)1[a-z0-9]{20,}/gi

// URLs: http(s) and ws(s)
const URL_REGEX = /(?:https?|wss?):\/\/[^\s<>)"']+/gi

// Email addresses
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

// Mastodon / Fediverse handles: @user@instance.tld (applied before email to avoid partial match)
const MASTODON_HANDLE_REGEX = /@[\w.-]+@[\w-]+(?:\.[\w-]+)+/g

// Twitter / X handles: @username (applied after Mastodon to avoid partial match)
const TWITTER_HANDLE_REGEX = /@\w{1,15}\b/g

// Lightning invoices (BOLT-11) and LNURL
const LIGHTNING_REGEX = /(?:lightning:)?ln(?:bc|tb|bcrt|tbs|url)\S+/gi

// Cashu tokens
const CASHU_REGEX = /cashu[AB][A-Za-z0-9_-]{20,}/g

// Hex-like sequences (file hashes, event ids, etc.) — 20+ hex chars
const HEX_SEQUENCE_REGEX = /\b[a-f0-9]{20,}\b/gi

// File extensions left over from stripped URLs
const FILE_EXT_REGEX = /\.[a-zA-Z0-9]{2,5}\b/g

// Domain-like fragments left after URL stripping (e.g. ".blossom.band/")
const DOMAIN_FRAGMENT_REGEX = /(?:\.[a-zA-Z0-9-]+){2,}(?:\/\S*)?/g

// Leftover protocol prefixes (e.g. "https://") after URL host was stripped
const PROTOCOL_PREFIX_REGEX = /(?:https?|wss?):\/\/\s*/gi

// Repeated characters (3+ of the same) — collapse to 2 to reduce n-gram noise
const REPEATED_CHARS_REGEX = /(.)\1{2,}/g

/**
 * Removes common non-language tokens from text before language detection.
 * Strips NIP-19 entities, URLs, emails, social handles, Lightning invoices,
 * hex sequences, leftover domain/protocol fragments, and collapses repeated chars.
 */
export function sanitizeText (text) {
  if (!text || typeof text !== 'string') return ''
  return text
    .replace(NIP19_REGEX, ' ')
    .replace(URL_REGEX, ' ')
    .replace(LIGHTNING_REGEX, ' ')
    .replace(CASHU_REGEX, ' ')
    .replace(MASTODON_HANDLE_REGEX, ' ')
    .replace(EMAIL_REGEX, ' ')
    .replace(TWITTER_HANDLE_REGEX, ' ')
    .replace(DOMAIN_FRAGMENT_REGEX, ' ')
    .replace(HEX_SEQUENCE_REGEX, ' ')
    .replace(FILE_EXT_REGEX, ' ')
    .replace(PROTOCOL_PREFIX_REGEX, ' ')
    .replace(REPEATED_CHARS_REGEX, '$1$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Strips markdown formatting from text, preserving readable content.
 */
export function stripMarkdown (text) {
  if (!text || typeof text !== 'string') return ''
  return text
    // Fenced code blocks (``` or ~~~)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    // Inline code
    .replace(/`[^`]+`/g, ' ')
    // Images ![alt](url)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    // Reference-style images ![alt][ref]
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ')
    // Links [text](url) → text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Reference links [text][ref] → text
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    // Reference definitions [ref]: url
    .replace(/^\[[^\]]*\]:\s+\S+.*$/gm, '')
    // HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Heading markers
    .replace(/^#{1,6}\s+/gm, '')
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Blockquote markers
    .replace(/^>\s?/gm, '')
    // Bold/italic/bold-italic
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
    // Strikethrough
    .replace(/~~([^~]+)~~/g, '$1')
    // Unordered list markers
    .replace(/^[\t ]*[-*+]\s+/gm, '')
    // Ordered list markers
    .replace(/^[\t ]*\d+\.\s+/gm, '')
}

/**
 * Counts Unicode letters in a string (works for Latin, CJK, Cyrillic, etc.).
 */
function countAlphaChars (text) {
  const matches = text.match(/\p{L}/gu)
  return matches ? matches.length : 0
}

/**
 * Detects the ISO 639-1 two-letter language code from a text string.
 * Uses lande as the primary detector (better accuracy on short/medium text),
 * falls back to franc when lande confidence is low.
 * Requires a minimum number of alphabetic characters to avoid false positives.
 * Returns undefined if no language could be determined.
 */
export function detectLanguage (text) {
  if (!text || typeof text !== 'string') return undefined
  text = text.trim()
  if (!text) return undefined

  if (countAlphaChars(text) < MIN_ALPHA_CHARS) return undefined

  const landeResult = topLandeResult(text)

  if (landeResult && landeResult[1] >= LANDE_MIN_CONFIDENCE) {
    return iso6393To1[landeResult[0]]
  }

  const francResult = franc(text)
  if (francResult !== 'und') return iso6393To1[francResult]

  if (landeResult) return iso6393To1[landeResult[0]]

  return undefined
}

function topLandeResult (text) {
  const results = lande(text)
  if (!results?.length) return undefined
  return results[0]
}

/**
 * Extracts the raw textual content from a supported event kind,
 * applying markdown stripping for LONG_FORM_CONTENT.
 * Returns the raw text string or undefined for unsupported kinds.
 * Does NOT sanitize — call sanitizeText() separately if needed.
 */
export function getEventText (event) {
  if (kindsUsingContent.has(event.kind)) {
    let text = event.content
    if (event.kind === eventKinds.LONG_FORM_CONTENT) text = stripMarkdown(text)
    return text
  }

  if (kindsUsingContentOrTitle.has(event.kind)) {
    if (event.content) return event.content
    const titleTag = event.tags?.find(t => t[0] === 'title')
    return titleTag?.[1]
  }

  return undefined
}

/**
 * Detects language for supported event kinds.
 * Sanitizes content before detection. Strips markdown for LONG_FORM_CONTENT.
 * Returns the ISO 639-1 code or undefined.
 */
export function detectEventLanguage (event) {
  if (kindsUsingContent.has(event.kind)) {
    let text = event.content
    if (event.kind === eventKinds.LONG_FORM_CONTENT) text = stripMarkdown(text)
    return detectLanguage(sanitizeText(text))
  }

  if (kindsUsingContentOrTitle.has(event.kind)) {
    const lang = detectLanguage(sanitizeText(event.content))
    if (lang) return lang
    const titleTag = event.tags?.find(t => t[0] === 'title')
    return detectLanguage(sanitizeText(titleTag?.[1]))
  }

  return undefined
}
