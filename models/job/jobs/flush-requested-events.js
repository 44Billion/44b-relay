import { flushRequestedEventsToMDB } from '#services/event/tracker/mdb/requested-events.js'

export async function run () {
  await flushRequestedEventsToMDB()
}

const config = {
  key: 'flushRequestedEvents',
  frequency: 60,
  // shouldUseLock=false because each process keeps its own sketch cache
  // and all of the processes must be able to merge their sketches
  // with the current mdb ones.
  shouldUseLock: false,
  run
}

export default config
