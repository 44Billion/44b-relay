export default {
  uid: 'pendingOps',
  primaryKey: 'key',
  attributes: [
    'key',
    'type',
    'data',
    'createdAt',
    'batchId',
    'position',
    'phase',
    'startedAt',
    'reservationKey',
    'source'
  ],
  settings: {
    // pendingOps is an internal queue. Consumers use document ids, filters and
    // sorting, never full-text queries. Indexing data (including compressed
    // sketches/HLLs) as words makes queue writes increasingly expensive as a
    // backlog grows.
    searchableAttributes: [],
    filterableAttributes: [
      'type',
      'phase',
      'reservationKey',
      'source'
    ],
    sortableAttributes: [
      'createdAt',
      'batchId',
      'position',
      'key',
      'startedAt'
    ]
  }
}
