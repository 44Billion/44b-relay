export default {
  uid: 'requestedPubkeys',
  primaryKey: 'key',
  attributes: [
    'key',
    'hll',
    'count'
  ],
  settings: {
    sortableAttributes: [
      'count'
    ]
  }
}
