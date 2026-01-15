export default {
  uid: 'pendingOps',
  primaryKey: 'key',
  attributes: [
    'key',
    'targetKey',
    'type',
    'data',
    'createdAt'
  ],
  settings: {
    filterableAttributes: [
      'targetKey',
      'type'
    ],
    sortableAttributes: [
      'createdAt'
    ]
  }
}
