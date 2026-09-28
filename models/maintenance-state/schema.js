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
    facetSearch: false,
    searchableAttributes: [],
    filterableAttributes: [
      'key',
      'jobKey',
      'createdAt'
    ]
  }
}
