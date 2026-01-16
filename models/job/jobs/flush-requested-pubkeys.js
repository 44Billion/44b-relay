import { flushRequestedPubkeysToMDB } from '#services/event/tracker/mdb/requested-pubkeys.js'

export async function run () {
  await flushRequestedPubkeysToMDB()
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
