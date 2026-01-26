export default {
  uid: 'maintenanceState',
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
