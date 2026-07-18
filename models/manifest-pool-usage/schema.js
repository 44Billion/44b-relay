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
    'mutationVersion',
    'reservationTokens',
    'settlementTokens',
    'metricTokens',
    'accountingTokens',
    'workflowTokens',
    'lastReconciliationToken'
  ],
  settings: {
    displayedAttributes: ['*'],
    filterableAttributes: ['key', 'scope', 'pubkey'],
    sortableAttributes: ['logicalBytes']
  }
}
