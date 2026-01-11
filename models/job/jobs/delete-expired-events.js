import { deleteExpiredEvents } from '#models/event/dao.js'

export async function run () {
  console.log('Running deleteExpiredEvents job...')
  await deleteExpiredEvents()
  console.log('Done deleteExpiredEvents job.')
}

const config = {
  key: 'deleteExpiredEvents',
  frequency: 60 * 60, // 1 hour
  shouldUseLock: true,
  run
}

export default config
