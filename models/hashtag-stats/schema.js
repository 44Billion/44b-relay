export default {
  uid: 'hashtagStats',
  primaryKey: 'key',
  attributes: [
    'key',       // '<lang>:<tag>' for tag docs, '__lang__:<lang>' for aggregate docs
    'docType',   // 'tag' | 'lang'
    'lang',      // ISO 639-1
    'tag',       // normalized hashtag (tag docs only)
    'words',     // split words array (tag docs only)
    'acronym',   // derived acronym or null (tag docs only)
    'count',     // decayable occurrence count (tag docs only)
    'neighbors', // [[tag, count], ...] top-N co-occurring tags (tag docs only)
    'taggedEventCount',   // (lang docs only)
    'untaggedEventCount', // (lang docs only)
    'updatedAt'  // timestamp in ms
  ],
  settings: {
    displayedAttributes: ['*'],
    searchableAttributes: ['key'],
    filterableAttributes: [
      'docType',
      'lang',
      'tag',
      'count'
    ],
    sortableAttributes: [
      'count'
    ]
  }
}
