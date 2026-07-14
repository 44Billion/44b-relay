/* eslint-disable camelcase */
import { maxDateNowSeconds } from '#config/mdb.js'
import { bytesToBase64 } from '#helpers/base64.js'
import { base16ToBytes } from '#helpers/base16.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { OLD_EVENT_AUTH_REQUIRED_AFTER_SECONDS, eventKinds } from '#constants/event.js'

const textEncoder = new TextEncoder()
export function addressToRef ({ address, kind, pubkey, dTag }) {
  address ??= `${kind}:${pubkey}:${dTag ?? ''}`
  return bytesToBase64(sha256(textEncoder.encode(address)))
}

export function idToRef (id) {
  return bytesToBase64(base16ToBytes(id))
}

// These events have one-letter (indexable) tags because
// they are widely used even though it would be more correct
// to e.g. make `p` tag be `pp` for the tag to not be indexed
// because they are usually meant to be consumed by the author only,
// so we won't support searching for them by some indexable tag
// to save space.
const eventKindsToIgnoreIndexableTags = {
  [eventKinds.FOLLOWS]: true,
  [eventKinds.MUTE_LIST]: true,
  [eventKinds.READ_WRITE_RELAYS]: true,
  [eventKinds.PINNED_NOTES]: true,
  [eventKinds.BOOKMARKS]: true,
  [eventKinds.COMMUNITIES]: true,
  [eventKinds.PUBLIC_CHATS]: true,
  [eventKinds.SIMPLE_GROUPS]: true,
  [eventKinds.RELAY_FEEDS]: true,
  [eventKinds.INTERESTS]: true,
  [eventKinds.MEDIA_FOLLOWS]: true,
  [eventKinds.EMOJIS]: true,
  [eventKinds.GOOD_WIKI_AUTHORS]: true,
  [eventKinds.FOLLOW_SET]: true,
  [eventKinds.BOOKMARK_SET]: true,
  [eventKinds.CURATION_SET]: true,
  [eventKinds.VIDEO_CURATION_SET]: true,
  [eventKinds.PICTURE_CURATION_SET]: true,
  [eventKinds.KIND_MUTE_SET]: true,
  // Interest set is an exception because
  // it's expected to be discoverable by others
  // to help them enrich their own set with
  // others' set images and descriptions
  [eventKinds.INTEREST_SET]: false,
  [eventKinds.RELEASE_ARTIFACT_SET]: true,
  [eventKinds.APP_CURATION_SET]: true,
  [eventKinds.CALENDAR]: true,
  [eventKinds.STARTER_PACK]: true,
  [eventKinds.MEDIA_STARTER_PACK]: true,
  [eventKinds.LIST]: true
}
const almostAlwaysIndexableTags = new Set(['d', 'k'])
const DAY_SECONDS = 60 * 60 * 24
const PRIVATE_DELIVERY_MAX_RETENTION_SECONDS = DAY_SECONDS * 2
const PRIVATE_DELIVERY_KINDS = new Set([
  eventKinds.PRIVATE_CHANNEL_BROADCAST,
  eventKinds.GIFT_WRAP
])

// These caps are local record metadata. They never rewrite a signed event tag.
function applyExpirationRetentionPolicy ({ kind, expiresAt, receivedAt, now }) {
  if (PRIVATE_DELIVERY_KINDS.has(kind)) {
    const maxExpiration = receivedAt + PRIVATE_DELIVERY_MAX_RETENTION_SECONDS
    return expiresAt == null || expiresAt > maxExpiration
      ? maxExpiration
      : expiresAt
  }

  if (kind === eventKinds.DELETION) {
    const maxExpiration = now + OLD_EVENT_AUTH_REQUIRED_AFTER_SECONDS
    return !expiresAt || expiresAt > maxExpiration
      ? maxExpiration
      : expiresAt
  }

  if ([6, 7, 16].includes(kind)) {
    const maxExpiration = now + DAY_SECONDS * 3
    return !expiresAt || expiresAt > maxExpiration
      ? maxExpiration
      : expiresAt
  }

  return expiresAt
}

export const MAX_INDEXABLE_TAGS = 10
export const MAX_INDEXABLE_TAG_VALUE_LENGTH = 1000
export function eventToRecord (event, {
  language, expiresAt, lastAccessedAt, receivedAt, isContentSearchable = false, fts,
  commentCounter, replyCounter, repostCounter, quoteCounter, topics
} = {}) {
  const { id, kind, pubkey, created_at, sig } = event
  const record = { id, kind, pubkey, created_at, sig }
  const now = Math.floor(Date.now() / 1000)
  const recordReceivedAt = receivedAt ?? now

  let dTag
  let isIndexable
  let tagIndex = 0
  for (const [k, v, ...extraValues] of event.tags) {
    isIndexable = v !== undefined &&
      v.length <= MAX_INDEXABLE_TAG_VALUE_LENGTH &&
      /^[A-Za-z]$/.test(k) &&
      // The "k" tag is always indexable because some NIP-50 lists
      // that allow many event kinds may use it to tell which
      // kinds are included in the list.
      (!eventKindsToIgnoreIndexableTags[kind] || almostAlwaysIndexableTags.has(k))

    if (isIndexable && (record.indexableTags?.length || 0) < MAX_INDEXABLE_TAGS) {
      (record.indexableTags ??= []).push(`${k} ${v ?? ''}`)
      ;(record.indexableTagExtras ??= []).push([tagIndex, ...extraValues])
    } else {
      (record.nonIndexableTags ??= []).push(event.tags[tagIndex])
    }
    switch (k) {
      case 'd': { if (v !== undefined) dTag ??= v; break }
      case 'expiration': {
        if (![null, undefined].includes(expiresAt)) break
        try {
          const expUint = parseInt(v, 10); if (!Number.isNaN(expUint) && expUint >= 0) { expiresAt ??= Math.min(maxDateNowSeconds, expUint) }
        } catch (_err) {}; break
      }
    }
    tagIndex++
  }

  expiresAt = applyExpirationRetentionPolicy({ kind, expiresAt, receivedAt: recordReceivedAt, now })

  if (!dTag && dTag !== '') {
    if ((kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000)) dTag = ''
    else {
      switch (kind) {
        case 0:
        case 3:
          dTag = ''; break
        // Although spec says reactions can be many for the same reference,
        // we won't allow it, to save db space
        case 7: {
          const reversedTags = [...event.tags].reverse()
          const softDTag = reversedTags.find(v => ['a', 'e', 'i'].includes(v[0])) ||
            reversedTags.find(v => v[0] === 'p')
          dTag = softDTag?.[1] ?? ''
          break
        }
      }
    }
  }
  Object.assign(record, {
    ref: dTag !== undefined
      ? addressToRef({ kind, pubkey, dTag })
      : idToRef(event.id),
    ...(language && { language }),
    ...(fts && { fts }),
    ...(isContentSearchable ? { ftsContent: event.content } : { nonFtsContent: event.content }),
    ...(expiresAt && { expiresAt }),
    ...(commentCounter && { commentCounter }),
    ...(replyCounter && { replyCounter }),
    ...(repostCounter && { repostCounter }),
    ...(quoteCounter && { quoteCounter }),
    ...(topics?.length && { topics }),
    lastAccessedAt: lastAccessedAt ?? now,
    receivedAt: recordReceivedAt
  })
  return record
}

export function recordToEvent (record, { withMeta = false } = {}) {
  const {
    id, kind, pubkey, created_at, sig,
    indexableTags = [], indexableTagExtras = [], nonIndexableTags,
    ftsContent, nonFtsContent, commentCounter, replyCounter, repostCounter, quoteCounter
  } = record
  const content = ftsContent ?? nonFtsContent ?? ''
  // reconstruct tags
  const tags = Array.isArray(nonIndexableTags) ? [...nonIndexableTags] : []
  for (let i = 0; i < indexableTags.length; i++) {
    const [k, v] = indexableTags[i].split(' ', 2)
    const [tagIndex, ...extraValues] = indexableTagExtras[i]
    tags.splice(tagIndex, 0, [k, v, ...extraValues])
  }
  return {
    id, kind, pubkey, tags, content, created_at, sig, ...(withMeta && {
      meta: {
        ...(commentCounter && { commentCounter }),
        ...(replyCounter && { replyCounter }),
        ...(repostCounter && { repostCounter }),
        ...(quoteCounter && { quoteCounter })
      }
    })
  }
}
