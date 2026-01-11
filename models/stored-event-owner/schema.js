export default {
  uid: 'storedEventOwners',
  primaryKey: 'key',
  settings: {
    filterableAttributes: [
      'key',
      'entity', // 'pk' or 'ip'
      'popularityLevel',
      'lastActiveAt'
    ],
    sortableAttributes: [
      'usedBytes'
    ]
  }
}
