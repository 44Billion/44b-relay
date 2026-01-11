import { flushIpActivityToMDB } from '#services/event/tracker/mdb/ip-activity.js'

export async function run () {
  await flushIpActivityToMDB()
}

const config = {
  key: 'flushIpActivity',
  frequency: 60, // 1 minute
  shouldUseLock: false,
  run
}

export default config
