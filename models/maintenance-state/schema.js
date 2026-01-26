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
    filterableAttributes: [
      'key',
      'jobKey',
      'createdAt'
    ]
  }
}
