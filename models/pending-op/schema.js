export default {
  uid: 'pendingOps',
  primaryKey: 'key',
  attributes: [
    'key',
    'type',
    'data',
    'createdAt'
  ],
  settings: {
    filterableAttributes: [
      'type'
    ],
    sortableAttributes: [
      'createdAt'
    ]
  }
}
