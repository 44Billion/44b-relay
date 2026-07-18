export default {
  uid: 'manifestPoolUsage',
  primaryKey: 'key',
  attributes: [
    'key',
    'scope',
    'pubkey',
    'logicalBytes',
    'manifestCount',
    'pruningCount',
    'rejectionCount',
    'usedDatabaseSize',
    'reconciledAt',
    'reservationTokens'
  ],
  settings: {
    displayedAttributes: ['*'],
    filterableAttributes: ['key', 'scope', 'pubkey'],
    sortableAttributes: ['logicalBytes']
  }
}
