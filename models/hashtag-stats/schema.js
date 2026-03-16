export default {
  uid: 'hashtagStats',
  primaryKey: 'key',
  attributes: [
    'key',       // '<lang>-<tag>'
    'lang',      // ISO 639-1
    'tag',       // normalized hashtag
    'words',     // split words array
    'acronym',   // derived acronym or null
    'count',     // decayable occurrence count
    'neighbors', // [[tag, count], ...] top-N co-occurring tags
    'icon',           // resolved icon URL or null
    'embedding',      // Float32 array (384 dims) from multilingual-e5-small
    'embeddingHash',  // hash of the topic text used for embedding — detects content changes
    'updatedAt'       // timestamp in ms
  ],
  settings: {
    displayedAttributes: ['*'],
    searchableAttributes: ['key'],
    filterableAttributes: [
      'key',
      'lang',
      'tag',
      'count',
      'icon'
    ],
    sortableAttributes: [
      'count'
    ]
  }
}
