import { defaultRankingRules } from '#config/mdb.js'

export default {
  uid: 'popularPubkeys',
  primaryKey: 'key',
  attributes: [
    'key',
    'filter',
    'relegatedFilter'
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
