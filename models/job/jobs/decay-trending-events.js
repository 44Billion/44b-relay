import mdb from '#services/db/mdb.js'

// Rhai script to recalculate the count field based on age
// Formula:
// points = (commentCount * 2.0) + (replyCount * 2.0) + (repostCount * 1.0) + (quoteCount * 1.5)
// ageHours = (now - created_at) / 3600000
// engagementCount = points / (ageHours + 2.0)^1.8
export const rhaiFunction = `
  let now = context.now;
  let created_at_ms = doc.created_at * 1000;
  let age_ms = now - created_at_ms;
  let age_hours = age_ms / 3600000.0;
  if age_hours < 0.0 { age_hours = 0.0; }

  let comment_count = doc.commentCount || 0;
  let reply_count = doc.replyCount || 0;
  let repost_count = doc.repostCount || 0;
  let quote_count = doc.quoteCount || 0;

  let points = (comment_count * 2.0) + (reply_count * 2.0) + (repost_count * 1.0) + (quote_count * 1.5);

  // Rhai doesn't have a built-in pow function for floats in all environments,
  // but Meilisearch Rhai might support ** operator or we can approximate.
  // Let's use the ** operator as shown in Meilisearch docs.
  doc.engagementCount = points / ((age_hours + 2.0) ** 1.8);
  doc
`

export async function run () {
  console.log('Running trending events decay...')
  const index = mdb.index('events')

  // Filter: Events created within the last 24 hours with engagementCount > 0
  const twentyFourHoursAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60)
  const filter = `created_at >= ${twentyFourHoursAgo} AND engagementCount > 0`

  try {
    console.log('Trending events decay task enqueued...')
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
      console.log('events index not found, skipping trending events decay.')
      return
    }
    console.error('Failed to run trending events decay:', err)
  }
}

const config = {
  key: 'decayTrendingEvents',
  frequency: 5 * 60, // Run every 5 minutes
  shouldUseLock: true,
  run
}

export default config
