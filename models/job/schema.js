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
    'ownerPid',
    'continuationRequested',
    'heartbeatTolerance',
    'lastError',
    'erroedAt',
    'heartbeatedAt'
  ],
  settings: {
    facetSearch: false,
    displayedAttributes: [
      '*'
    ],
    searchableAttributes: [],
    filterableAttributes: [
      'key'
    ],
    sortableAttributes: [
      'startedAt',
      'endedAt'
    ]
  }
}
