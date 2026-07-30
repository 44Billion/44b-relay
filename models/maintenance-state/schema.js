export default {
  uid: 'maintenanceStates',
  primaryKey: 'key',
  attributes: [
    'key',
    'jobKey',
    'createdAt',
    'levelUpdatedFilter',
    'maintenanceDoneFilter'
  ],
  settings: {
    searchableAttributes: [],
    filterableAttributes: [
      'key',
      'jobKey',
      'createdAt'
    ]
  }
}
