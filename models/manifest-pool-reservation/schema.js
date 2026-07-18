export default {
  uid: 'manifestPoolReservations',
  primaryKey: 'key',
  attributes: [
    'key',
    'eventId',
    'ref',
    'pubkey',
    'newBytes',
    'observedOldEventId',
    'observedOldBytes',
    'reservedBytes',
    'reservedCount',
    'actualDeltaBytes',
    'actualDeltaCount',
    'state',
    'reason',
    'rejectionScope',
    'globalSettled',
    'authorSettled',
    'globalRejectionCounted',
    'authorRejectionCounted',
    'createdAt',
    'updatedAt'
  ],
  settings: {
    displayedAttributes: ['*'],
    filterableAttributes: ['key', 'eventId', 'ref', 'pubkey', 'state'],
    sortableAttributes: ['createdAt', 'updatedAt', 'key']
  }
}
