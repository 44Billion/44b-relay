import { defaultRankingRules } from '#config/mdb.js'

export default {
  uid: 'ipActivities',
  primaryKey: 'key',
  attributes: [
    'key',
    'data'
  ],
  settings: {
    displayedAttributes: [
      '*'
    ],
    searchableAttributes: [
      'key'
    ],
    filterableAttributes: [
      'key'
    ],
    sortableAttributes: [],
    rankingRules: [
      ...defaultRankingRules
    ]
  }
}
