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
    'icon',      // resolved icon URL or null
    'updatedAt'  // timestamp in ms
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
