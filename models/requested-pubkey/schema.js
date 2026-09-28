export default {
  uid: 'requestedPubkeys',
  primaryKey: 'key',
  attributes: [
    'key',
    'hll',
    'count'
  ],
  settings: {
    facetSearch: false,
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
