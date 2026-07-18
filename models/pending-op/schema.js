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
