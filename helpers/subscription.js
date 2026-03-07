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

  extensions.isRising = filter.search.includes('is:rising')
  if (extensions.isRising) filter.search = filter.search.replace(/is:rising/g, '').trim()

  extensions.isPopular = filter.search.includes('is:popular')
  if (extensions.isPopular) filter.search = filter.search.replace(/is:popular/g, '').trim()

  // includeSpam is shadowed when any explicit audience filter is set
  if (extensions.includeSpam && (extensions.isSpam || extensions.isRising || extensions.isPopular)) {
    extensions.includeSpam = false
  }

  extensions.sortTop = filter.search.includes('sort:top')
  if (extensions.sortTop) filter.search = filter.search.replace(/sort:top/g, '').trim()

  const languageMatches = [...filter.search.matchAll(/language:([a-zA-Z]{2})/g)]
  if (languageMatches.length > 0) {
    extensions.language = [...new Set(languageMatches.map(m => m[1].toLowerCase()))].slice(0, 5) // max 5 languages
    filter.search = filter.search.replace(/language:[a-zA-Z]{2}/g, '').trim()
  }

  const topicMatches = [...filter.search.matchAll(/topic:([a-zA-Z0-9_-]{1,80})/g)]
  if (topicMatches.length > 0) {
    extensions.topic = [...new Set(topicMatches.map(m => m[1].toLowerCase()))].slice(0, 10) // max 10 topics
    filter.search = filter.search.replace(/topic:[a-zA-Z0-9_-]{1,80}/g, '').trim()
  }

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

/**
 * Builds a Meilisearch-compatible OR popularity filter array for broad filters.
 * is:popular → popularityLevel <= 5
 * is:rising → popularityLevel = 6
 * is:spam → popularityLevel > 6
 * includeSpam → no filter (all levels)
 * default (none of the above) → popularityLevel <= 6
 *
 * Multiple is:* extensions are OR-combined.
 * includeSpam is ignored when any is:* extension is set.
 */
export function buildPopularityFilter ({ isSpam, isRising, isPopular, includeSpam }) {
  const clauses = []
  if (isPopular) clauses.push('popularityLevel <= 5')
  if (isRising) clauses.push('popularityLevel = 6')
  if (isSpam) clauses.push('popularityLevel > 6')

  if (clauses.length > 0) return clauses

  // includeSpam (already shadowed to false if any is:* was set)
  if (includeSpam) return null // no filter → all levels

  // default: only non-spam
  return ['popularityLevel <= 6']
}

const SUPPORTED_PATH_EXTENSIONS = new Set([
  'include:spam', 'is:spam', 'is:rising', 'is:popular', 'sort:top'
  // language:xx are handled separately (dynamic)
])

/**
 * Parses a /.well-known/nip50/<ext1>/<ext2>/... pathname into an object
 * with extension flags and languages array.
 * Returns null if the pathname is not a valid /.well-known/nip50/ path.
 *
 * Valid extensions: include:spam, is:spam, is:rising, is:popular, sort:top, language:xx
 * Example: /.well-known/nip50/sort:top/language:en → { sortTop: true, language: ['en'] }
 */
export function parseNip50PathExtensions (pathname) {
  if (!pathname.startsWith('/.well-known/nip50/')) return null

  const segments = pathname.slice('/.well-known/nip50/'.length).split('/').filter(Boolean)
  if (segments.length === 0) return null

  const extensions = {}
  const languages = []
  const topicValues = []

  for (const segment of segments) {
    const decoded = decodeURIComponent(segment).toLowerCase()
    if (SUPPORTED_PATH_EXTENSIONS.has(decoded)) {
      switch (decoded) {
        case 'include:spam': extensions.includeSpam = true; break
        case 'is:spam': extensions.isSpam = true; break
        case 'is:rising': extensions.isRising = true; break
        case 'is:popular': extensions.isPopular = true; break
        case 'sort:top': extensions.sortTop = true; break
      }
    } else if (/^language:[a-z]{2}$/.test(decoded)) {
      languages.push(decoded.slice(9))
    } else if (/^topic:[a-z0-9_-]{1,80}$/.test(decoded)) {
      topicValues.push(decoded.slice(6))
    } else {
      return null // unknown extension → invalid path
    }
  }

  // includeSpam is shadowed when any explicit audience filter is set
  if (extensions.includeSpam && (extensions.isSpam || extensions.isRising || extensions.isPopular)) {
    extensions.includeSpam = false
  }

  if (languages.length > 0) {
    extensions.language = [...new Set(languages)].slice(0, 5)
  }

  if (topicValues.length > 0) {
    extensions.topic = [...new Set(topicValues)].slice(0, 10)
  }

  return extensions
}

/**
 * Merges path-based extensions into a parsed filter.
 * Path extensions act as defaults — they are applied only if the filter
 * doesn't already have the corresponding extension set via search field.
 */
export function applyPathExtensionsToFilter (filter, pathExtensions) {
  if (!pathExtensions) return

  // Boolean extensions: only apply if not set on the filter
  for (const key of ['includeSpam', 'isSpam', 'isRising', 'isPopular', 'sortTop']) {
    if (pathExtensions[key] && !filter[key]) filter[key] = true
  }

  // Language: merge path languages with filter languages (dedupe)
  if (pathExtensions.language?.length) {
    if (filter.language?.length) {
      filter.language = [...new Set([...filter.language, ...pathExtensions.language])].slice(0, 5)
    } else {
      filter.language = pathExtensions.language
    }
  }

  // Topic: merge path topics with filter topics (dedupe)
  if (pathExtensions.topic?.length) {
    if (filter.topic?.length) {
      filter.topic = [...new Set([...filter.topic, ...pathExtensions.topic])].slice(0, 10)
    } else {
      filter.topic = pathExtensions.topic
    }
  }

  // Re-apply shadowing: explicit audience filters shadow includeSpam
  if (filter.includeSpam && (filter.isSpam || filter.isRising || filter.isPopular)) {
    filter.includeSpam = false
  }
}
