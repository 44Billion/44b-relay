import { defaultRankingRules } from '#config/mdb.js'

export default {
  uid: 'ipActivity',
  primaryKey: 'key',
  attributes: [
    'key',
    'json'
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
