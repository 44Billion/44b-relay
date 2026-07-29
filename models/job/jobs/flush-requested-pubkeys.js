import { flushRequestedPubkeysToMDB } from '#services/event/tracker/mdb/requested-pubkeys.js'
import { checkpoint } from '#helpers/abort.js'

export async function run ({ signal } = {}) {
  checkpoint(signal)
  await flushRequestedPubkeysToMDB()
  checkpoint(signal)
}

const config = {
  key: 'flushRequestedPubkeys',
  frequency: 60,
  // shouldUseLock=false because each process keeps their own hll caches
  // and all of the processes must be able to merge their hlls
  // with the current mdb ones.
  shouldUseLock: false,
  run
}

export default config
