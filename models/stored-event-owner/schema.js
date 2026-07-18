export default {
  uid: 'storedEventOwners',
  primaryKey: 'key',
  attributes: [
    'key',
    'entityType',
    'popularityLevel',
    'previousPopularityLevel',
    'usedBytes',
    'lastActiveAt',
    'accountingTokens'
  ],
  settings: {
    filterableAttributes: [
      'key',
      'entityType', // 'pubkey' or 'ip'
      'popularityLevel',
      'lastActiveAt'
    ],
    sortableAttributes: [
      'key',
      'usedBytes'
    ]
  }
}
