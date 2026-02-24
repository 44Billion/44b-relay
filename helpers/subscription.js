import { eventTags } from '#constants/event.js'
import { isType } from '#helpers/shared.js'
import { isKnownEventKind, getPublishedAt } from '#helpers/event.js'
const isSingleLetterTagRegExp = /^#[A-Za-z]$/
const isTagQuery = key => isSingleLetterTagRegExp.test(key)

// We allow these broad filters now by returning less spammy events (of popularity <= 6)
// These cover relay-based feed (just chosen kinds),
// topic-based feeds (#t + kinds), category-based feeds (#l + kinds),
// replies (#e/a/i + kinds) and notifications (#p with or without kinds) use-cases
// There may be other use-cases we don't see yet involving other indexable tags but #d
// so intead of /^#[aeilpt]$/i.test(k) we accept any one letter tag except #d
export function isAllowedEvenIfBroadFilter (filter) {
  return (
    // specific kinds or
    !!filter.kinds?.length ||
    // referencing authors, ids, addresses, or external entities
    Object.entries(filter).some(([k, v]) => v?.length && /^#[A-Za-ce-z]$/.test(k))
  )
}

export function isBroadFilter (filter) {
  if (process.env.IS_INTEGRATION_TEST === 'true') return false
  let precision = 0
  if (filter.ids?.length) precision += 2
  if (filter.authors?.length) precision += 1
  if (filter.kinds?.length) {
    precision += 1
    if (Object.entries(filter).some(([k, v]) => k === '#d' && v?.length)) precision += 1
  } else {
    if (Object.entries(filter).some(([k, v]) => k.startsWith('#') && v?.length)) precision += 1
  }

  return precision < 2
}

// NIP-50
export function extractFilterExtensions (filter) {
  const extensions = {}
  extensions.includeSpam = filter.search.includes('include:spam')
  if (extensions.includeSpam) filter.search = filter.search.replace(/include:spam/g, '').trim()

  extensions.isSpam = filter.search.includes('is:spam')
  if (extensions.isSpam) filter.search = filter.search.replace(/is:spam/g, '').trim()

  extensions.sortTop = filter.search.includes('sort:top')
  if (extensions.sortTop) filter.search = filter.search.replace(/sort:top/g, '').trim()

  return extensions
}

function parseSubscriptionFilters ({ filters }) {
  return filters
    .flat() // in case filters[0] is wrongly [] instead of {}
    .map(filter => {
      const ret = {}
      if (!isType(filter, 'object')) return ret

      // ids
      if (isType(filter.ids, 'array')) {
        const ids = filter.ids.filter(v =>
          isType(v, 'string') &&
          /^[0-9A-F]{4,64}$/i.test(v) // custom: 4 chars min (like expect 0000 PoW)
        )
          .map(v => v.toLowerCase())
          .slice(0, 500) // custom: 500 ids limit
        if (ids.length > 0) ret.ids = [...new Set(ids)]
      }

      // authors
      if (isType(filter.authors, 'array')) {
        const authors = filter.authors.filter(v =>
          isType(v, 'string') &&
          /^[0-9A-F]{4,64}$/i.test(v) // custom: 4 chars min
        )
          .map(v => v.toLowerCase())
          .slice(0, 500) // custom: 500 authors limit
        if (authors.length > 0) ret.authors = [...new Set(authors)]
      }

      // kinds
      if (isType(filter.kinds, 'array')) {
        const kinds = filter.kinds.filter(isKnownEventKind)
          .slice(0, 10) // custom: 10 kinds limit
        if (kinds.length > 0) ret.kinds = [...new Set(kinds)]
      }

      // #e, #p and NIP-12: Generic Tag Queries
      const isUrlTagQuery = filterKey => !!({
        [eventTags.REFERENCE]: true
      })[filterKey]
      const getCharLimitsByTagKey = filterKey =>
        [`#${eventTags.EVENT}`, `#${eventTags.PUBKEY}`].includes(filterKey)
          ? [64, 65]
          : (isUrlTagQuery(filterKey) || filterKey === eventTags.DEDUPLICATION)
              ? [1, 2000]
              : [1, 81] // custom: 80 chars max
      for (const [filterKey, filterValue] of Object.entries(filter).filter(([k]) => isTagQuery(k))) {
        if (isType(filterValue, 'array')) {
          const charLimits = getCharLimitsByTagKey(filterKey)
          const tagFilter = filterValue.filter(v =>
            isType(v, 'string') &&
            v.length >= charLimits[0] && v.length < charLimits[1]
          )
            .slice(0, 10) // custom: 10 tags limit
          if (tagFilter.length > 0) ret[filterKey] = [...new Set(tagFilter)]
        }
      }

      if (
        isType(filter.since, 'number') &&
        // (seconds, meaning / 1000) https://stackoverflow.com/questions/11526504/minimum-and-maximum-date
         filter.since >= -8640000000000 &&
         filter.since <= 8640000000000
      ) {
        ret.since = filter.since
      }

      if (
        isType(filter.until, 'number') &&
        filter.until >= -8640000000000 &&
        filter.until <= 8640000000000
      ) {
        ret.until = filter.until
      }

      if (
        isType(filter.limit, 'number') &&
        filter.limit >= 0 // 0 will return EOSE and start streaming realtime
      ) {
        ret.limit = Math.min(200, filter.limit) // custom: 200 max limit
      }

      if (isType(filter.search, 'string')) {
        const extensions = extractFilterExtensions(filter)
        Object.assign(ret, extensions)
        ret.search = filter.search.slice(0, 128) // custom: 128 chars limit
      }

      return ret
    })
    .filter(v => Object.keys(v).length > 0)
}

// filters are already normalized and
// event is expected to be already checked for validity
function doesMatchASubscriptionFilter ({ filters, event }) {
  const memoizedGetPublishedAt = (at => event => (at ??= getPublishedAt(event)))()
  return filters.some(filter => {
    // Note: all filter conditions must match, so if any doesn't match, we return false
    // since
    if (filter.since !== undefined && filter.since > memoizedGetPublishedAt(event)) return false

    // until
    if (filter.until !== undefined && filter.until < memoizedGetPublishedAt(event)) return false

    // ids
    if (filter.ids?.length && !filter.ids.some(v => event.id.startsWith(v))) return false

    // kinds
    if (filter.kinds?.length && !filter.kinds.includes(event.kind)) return false

    // authors (pubkey and tags.*.delegation.1 https://github.com/nostr-protocol/nips/blob/master/26.md)
    // https://gitlab.com/minds/minds/-/issues/3305#note_1049831369
    // "From the Minds side, we will create initial keypairs for ALL users (as is working right now),
    // but we will allow users to set their root pubkey"
    if (filter.authors?.length > 0) {
      if (filter.authors.every(v => !event.pubkey.startsWith(v))) return false
      // const delegatorPubkey = event.tags.find(v => v[0] === eventTags.DELEGATION)?.[1] ?? ''
      // if (
      //   !filter.authors.some(v =>
      //     // won't use exactly as NIP: event.pubkey.startsWith(v) || delegatorPubkey.startsWith(v)
      //     delegatorPubkey ? delegatorPubkey.startsWith(v) : event.pubkey.startsWith(v)
      //   )
      // ) return false
    }

    // #e, #p and NIP-12: Generic Tag Queries
    for (const [filterKey, filterValues] of Object.entries(filter).filter(([k, v]) => isTagQuery(k) && v.length > 0)) {
      if (event.tags.every(v => v[0] !== filterKey[1] || !filterValues.includes(v[1]))) return false
    }

    return true
  })
}

export {
  parseSubscriptionFilters,
  doesMatchASubscriptionFilter
}
