export default {
  uid: 'jobs',
  primaryKey: 'key',
  attributes: [
    'key',
    'startedAt',
    'endedAt',
    'lockKey',
    'lastError',
    'erroedAt'
  ],
  settings: {
    displayedAttributes: [
      '*'
    ],
    searchableAttributes: [
      'key'
    ],
    filterableAttributes: [
      'key'
    ],
    sortableAttributes: [
      'startedAt',
      'endedAt'
    ]
  }
}
