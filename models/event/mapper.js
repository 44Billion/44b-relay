/* eslint-disable camelcase */
import { maxDateNowSeconds } from '#config/mdb.js'
import { bytesToBase64 } from '#helpers/base64.js'
import { base16ToBytes } from '#helpers/base16.js'
import { sha256 } from '@noble/hashes/sha2.js'

const textEncoder = new TextEncoder()
export function addressToRef ({ address, kind, pubkey, dTag }) {
  address ??= `${kind}:${pubkey}:${dTag ?? ''}`
  return bytesToBase64(sha256(textEncoder.encode(address)))
}

export function idToRef (id) {
  return bytesToBase64(base16ToBytes(id))
}

export const MAX_INDEXABLE_TAGS = 10
export const MAX_INDEXABLE_TAG_VALUE_LENGTH = 1000
export function eventToRecord (event, { language, expiresAt, lastAccessedAt, receivedAt, isContentSearchable = false, fts } = {}) {
  const { id, kind, pubkey, created_at, sig } = event
  const record = { id, kind, pubkey, created_at, sig }
  const now = Math.floor(Date.now() / 1000)

  let dTag
  let isIndexable
  let tagIndex = 0
  for (const [k, v, ...extraValues] of event.tags) {
    isIndexable = v !== undefined &&
      v.length <= MAX_INDEXABLE_TAG_VALUE_LENGTH &&
      /^[A-Za-z]$/.test(k)

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

  if (kind === 5 || kind === 7) {
    const maxExpiration = now + 60 * 60 * 24 * 3
    if (!expiresAt || expiresAt > maxExpiration) expiresAt = maxExpiration
  }

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
    lastAccessedAt: lastAccessedAt ?? now,
    receivedAt: receivedAt ?? now
  })
  return record
}

export function recordToEvent (record) {
  const {
    id, kind, pubkey, created_at, sig,
    indexableTags = [], indexableTagExtras = [], nonIndexableTags,
    ftsContent, nonFtsContent
  } = record
  const content = ftsContent ?? nonFtsContent ?? ''
  // reconstruct tags
  const tags = Array.isArray(nonIndexableTags) ? [...nonIndexableTags] : []
  for (let i = 0; i < indexableTags.length; i++) {
    const [k, v] = indexableTags[i].split(' ', 2)
    const [tagIndex, ...extraValues] = indexableTagExtras[i]
    tags.splice(tagIndex, 0, [k, v, ...extraValues])
  }
  return { id, kind, pubkey, tags, content, created_at, sig }
}
