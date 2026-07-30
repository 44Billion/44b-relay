export default {
  uid: 'requestedPubkeys',
  primaryKey: 'key',
  attributes: [
    'key',
    'hll',
    'count'
  ],
  settings: {
    searchableAttributes: [],
    filterableAttributes: [
      'firstSeenAt'
    ],
    sortableAttributes: [
      'count',
      'firstSeenAt'
    ]
  }
}
