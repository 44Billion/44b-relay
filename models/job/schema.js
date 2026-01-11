export default {
  uid: 'jobs',
  primaryKey: 'key',
  attributes: [
    'key',
    'startedAt',
    'endedAt',
    'requestedAt',
    'lockKey',
    'lastError',
    'erroedAt',
    'heartbeatedAt'
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
