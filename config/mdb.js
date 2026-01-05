export const defaultRankingRules = [
  'words',
  'typo',
  'proximity',
  'attribute',
  // this only applies when there is explicit sort param like:
  // db.index('example').search('', { sort: ['ts:asc'] })
  'sort',
  'exactness'
  // v custom rules v
  // these will always apply
  // and are good to promote some records like discounted
  // ones with e.g. 'discountPercentage:desc'
]

export const maxDateNowSeconds = 8.64e15 / 1000
