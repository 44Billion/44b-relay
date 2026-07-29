import { deleteExpiredEvents } from '#models/event/dao.js'
import { checkpoint } from '#helpers/abort.js'

export async function run ({ signal } = {}) {
  console.log('Running deleteExpiredEvents job...')
  checkpoint(signal)
  await deleteExpiredEvents({ signal })
  checkpoint(signal)
  console.log('Done deleteExpiredEvents job.')
}

const config = {
  key: 'deleteExpiredEvents',
  frequency: 60 * 60, // 1 hour
  shouldUseLock: true,
  run
}

export default config
