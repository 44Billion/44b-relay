import mdb from '#services/db/mdb.js'
import { rhaiFunction } from './decay-trending-events.js'

export async function run () {
  console.log('Running trending (old) events decay...')
  const index = mdb.index('events')

  // Filter: Events older than 24 hours that still have a significant engagementCount.
  // A brand new event with just 1 engagement has an engagementCount of ~0.28.
  // By only decaying events with engagementCount > 0.01, we avoid processing
  // millions of old, irrelevant events, while ensuring that anything still
  // ranking high gets properly decayed over time.
  const twentyFourHoursAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60)
  const filter = `created_at < ${twentyFourHoursAgo} AND engagementCount > 0.01`

  try {
    console.log('Trending (old) events decay task enqueued...')
    const task = await index.updateDocumentsByFunction({
      function: rhaiFunction,
      filter,
      context: {
        now: Date.now()
      }
    })
    console.log(`Trending events decay task ${task.uid} done with status "${task.status}"`)
  } catch (err) {
    const isNotFound = err.code === 'index_not_found' || err.cause?.code === 'index_not_found'
    if (isNotFound) {
      console.log('events index not found, skipping trending (old) events decay.')
      return
    }
    console.error('Failed to run trending (old) events decay:', err)
  }
}

const config = {
  key: 'decayOldTrendingEvents',
  frequency: 6 * 60 * 60, // Run every 6 hours
  shouldUseLock: true,
  run
}

export default config
