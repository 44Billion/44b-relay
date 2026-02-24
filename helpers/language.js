import lande from 'lande'
import { franc } from 'franc'
import { iso6393To1 } from 'iso-639-3'
import { eventKinds } from '#constants/event.js'

const SHORT_TEXT_THRESHOLD = 50

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

/**
 * Removes common non-language tokens from text before language detection.
 * Strips NIP-19 entities, URLs, emails, social handles, Lightning invoices, etc.
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
 * Detects the ISO 639-1 two-letter language code from a text string.
 * Uses franc for texts >= 50 chars, lande for shorter texts.
 * Returns undefined if no language could be determined.
 */
export function detectLanguage (text) {
  if (!text || typeof text !== 'string') return undefined
  text = text.trim()
  if (!text) return undefined

  let iso3

  if (text.length < SHORT_TEXT_THRESHOLD) {
    iso3 = detectWithLande(text)
  } else {
    iso3 = franc(text)
    if (iso3 === 'und') {
      iso3 = detectWithLande(text)
    }
  }

  if (!iso3) return undefined
  return iso6393To1[iso3]
}

function detectWithLande (text) {
  const results = lande(text)
  if (results?.length > 0) return results[0][0]
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
