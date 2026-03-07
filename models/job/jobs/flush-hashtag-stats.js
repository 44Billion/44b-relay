import { flushHashtagStatsToMDB } from '#services/event/tracker/mdb/hashtag-stats.js'

export async function run () {
  await flushHashtagStatsToMDB()
}

const config = {
  key: 'flushHashtagStats',
  frequency: 60,
  // shouldUseLock=false because each process keeps their own local accumulators
  // and all processes must be able to merge their stats
  shouldUseLock: false,
  run
}

export default config
