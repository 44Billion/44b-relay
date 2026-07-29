export default {
  uid: 'jobs',
  primaryKey: 'key',
  attributes: [
    'key',
    'startedAt',
    'endedAt',
    'requestedAt',
    'lockKey',
    'revision',
    'ownerId',
    'ownerType',
    'heartbeatTolerance',
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
