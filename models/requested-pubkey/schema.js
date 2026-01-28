export default {
  uid: 'requestedPubkeys',
  primaryKey: 'key',
  attributes: [
    'key',
    'hll',
    'count'
  ],
  settings: {
    filterableAttributes: [
      'firstSeenAt'
    ],
    sortableAttributes: [
      'count',
      'firstSeenAt'
    ]
  }
}
