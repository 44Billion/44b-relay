import { defaultRankingRules } from '#config/mdb.js'

export default {
  uid: 'events',
  // https://www.meilisearch.com/docs/learn/core_concepts/primary_key#formatting-the-document-id
  // The document id must be an integer or a string.
  // If the id is a string, it can only contain alphanumeric characters (a-z, A-Z, 0-9),
  // hyphens (-), and underscores (_).
  primaryKey: 'ref',
  attributes: [
    'ref', // id or address: dTag ? bytesToBase64(sha256(new TextEncoder().encode(`${kind}:${pubkey}:${dTag}`)) : bytesToBase64(base16ToBytes(id)))
    'receivedAt', // in seconds
    // keep in memory and from time to time write to db
    // and if not dirty for a while, remove from memory
    'lastAccessedAt', // in seconds - debounce when setting this: once per day or hour
    'expiresAt', // in seconds
    'language', // optional, ISO 639-1 code, e.g., 'en', 'pt', 'es', 'fr', 'de', 'zh', etc
    // v nostr event v
    'id',
    'pubkey',
    'kind',
    'nonIndexableTags', // [tags[position], tags[position2], ...]
    // [`${keyN} ${valueN}`] // whitespace is a soft word separator - https://www.meilisearch.com/docs/learn/engine/datatypes#separators
    // useful in case we want to turn itags searchable (instead)
    // of just filterable
    // For filtering, = is like an exact search though case-insensitive
    'indexableTags',
    // [
    //   [original array position, ...tags[position].slice(2)],
    //   ...
    // ]
    'indexableTagExtras',
    'fts', // optional, searchable values from tags or other metadata
    'nonFtsContent', // not searchable
    'ftsContent', // event.content = record.ftsContent ?? record.nonFtsContent
    'created_at',
    'sig'
  ],
  // https://www.meilisearch.com/docs/reference/api/settings#settings-object
  settings: {
    displayedAttributes: [
      '*'
    ],
    searchableAttributes: [
      'ftsContent',
      'fts'
    ],
    filterableAttributes: [
      'id',
      'pubkey',
      'kind',
      'indexableTags',
      'created_at',
      'receivedAt',
      'lastAccessedAt',
      'expiresAt',
      'owner',
      'ip',
      'popularityLevel'
    ],
    sortableAttributes: [
      'created_at',
      'sat'
    ],
    rankingRules: [
      ...defaultRankingRules,
      'created_at:desc'
    ]
    // stopWords: [],
    // nonSeparatorTokens: [], // allows to remove of some tokens from the default list of separators - https://github.com/meilisearch/meilisearch/pull/3946
    // separatorTokens: [],
    // dictionary: [],
    // synonyms: {
    //   wolverine: ['xmen', 'logan'],
    //   logan: ['wolverine', 'xmen'],
    // }, // search-only, not filtering
    // distinctAttribute: null,
    // typoTolerance: { enabled, minWordSizeForTypos: { oneTypo, twoTypos }, disableOnWords: [], disableOnAttributes: [] }
    // faceting: { maxValuesPerFacet": 100 },
    // pagination": { maxTotalHits": 1000 },
    // proximityPrecision": 'byWord',
    // searchCutoffMs: null
  }
}
