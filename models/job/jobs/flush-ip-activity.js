import { flushIpActivityToMDB } from '#services/event/tracker/mdb/ip-activity.js'
import { checkpoint } from '#helpers/abort.js'

export async function run ({ signal } = {}) {
  checkpoint(signal)
  await flushIpActivityToMDB()
  checkpoint(signal)
}

const config = {
  key: 'flushIpActivity',
  frequency: 60, // 1 minute
  shouldUseLock: false,
  run
}

export default config
