export default {
  uid: 'pendingOps',
  primaryKey: 'key',
  attributes: [
    'key',
    'type',
    'data',
    'createdAt',
    'source'
  ],
  settings: {
    filterableAttributes: [
      'type',
      'source'
    ],
    sortableAttributes: [
      'createdAt'
    ]
  }
}
