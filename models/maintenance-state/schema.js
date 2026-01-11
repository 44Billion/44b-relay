export default {
  uid: 'maintenanceState',
  primaryKey: 'key',
  attributes: [
    'key',
    'jobKey',
    'createdAt',
    'levelUpdatedCuckoo',
    'maintenanceDoneCuckoo',
    'eventsProcessedCuckoo'
  ],
  settings: {
    filterableAttributes: [
      'key',
      'jobKey',
      'createdAt'
    ]
  }
}
