const textEncoder = new TextEncoder()
export function eventToRecord (event, { language, expiresAt, lastAccessedAt, receivedAt, isContentSearchable = false, fts } = {}) {
  const { id, kind, pubkey, created_at, sig } = event
  const record = { id, kind, pubkey, created_at, sig }

  let dTag
  let tagIndex = 0
  for (const [k, v, ...extraValues] of event.tags) {
    if (/[A-Za-z]/.test(k) && (
      v !== undefined ||
      (k === 'd' && kind >= 10000 && kind < 20000) // defaults the value to '' in this case
    )) {
      (record.indexableTags ??= []).push(`${k} ${v ?? ''}`)
      ;(record.indexableTagExtras ??= []).push([tagIndex, ...extraValues])
    } else {
      (record.nonIndexableTags ??= []).push(event.tags[tagIndex])
    }
    switch (k) {
      case 'd': { if (v !== undefined || (kind >= 10000 && kind < 20000)) dTag ??= v ?? ''; break }
      case 'expiration': {
        try {
          const expUint = parseInt(v, 10); if (!Number.isNaN(expUint) && expUint >= 0) { expiresAt ??= Math.min(maxDateNowSeconds, expUint) }
        } catch (_err) {}; break
      }
    }
    tagIndex++
  }
  if (!dTag) {
    switch (kind) {
      case 0:
      case 3:
        dTag = ''; break
      case 7:
        dTag = content; break
    }
  }
  const now = Math.floor(Date.now() / 1000)
  Object.assign(record, {
    ref: dTag
      ? bytesToBase64(sha256(textEncoder.encode(`${kind}:${pubkey}:${dTag}`)))
      : bytesToBase64(base16ToBytes(event.id)),
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
