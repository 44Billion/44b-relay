import { deleteStaleIps } from '#services/event/tracker/mdb/ip-activity.js'
import { checkpoint } from '#helpers/abort.js'

export async function run ({ signal } = {}) {
  console.log('Running deleteStaleIps job...')
  checkpoint(signal)
  await deleteStaleIps({ signal })
  checkpoint(signal)
  console.log('Done deleteStaleIps job.')
}

const config = {
  key: 'deleteStaleIps',
  frequency: 60 * 60 * 6, // 6 hours
  shouldUseLock: true,
  run
}

export default config
