import { flushHashtagStatsToMDB } from '#services/event/tracker/mdb/hashtag-stats.js'
import { checkpoint } from '#helpers/abort.js'

export async function run ({ signal } = {}) {
  checkpoint(signal)
  await flushHashtagStatsToMDB()
  checkpoint(signal)
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
