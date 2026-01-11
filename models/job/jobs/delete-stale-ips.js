import { deleteStaleIps } from '#services/event/tracker/mdb/ip-activity.js'

export async function run () {
  console.log('Running deleteStaleIps job...')
  await deleteStaleIps()
  console.log('Done deleteStaleIps job.')
}

const config = {
  key: 'deleteStaleIps',
  frequency: 60 * 60 * 6, // 6 hours
  shouldUseLock: true,
  run
}

export default config
