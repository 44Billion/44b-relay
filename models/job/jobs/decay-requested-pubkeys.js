import mdb from '#services/db/mdb.js'

export async function run () {
  console.log('Running requested pubkeys decay...')
  const index = mdb.index('requestedPubkeys')

  let maxCount = 0
  try {
    const res = await index.search('', {
      limit: 1,
      sort: ['count:desc'],
      attributesToRetrieve: ['count']
    })
    maxCount = res.hits[0]?.count || 0
  } catch (err) {
    const isNotFound = err.code === 'index_not_found' || err.cause?.code === 'index_not_found'
    if (isNotFound) {
      console.log('requestedPubkeys index not found, skipping decay.')
      return
    }
    console.error('Failed to fetch maxCount for decay:', err)
  }

  // Rhai script to decay older documents more significantly
  // Formula:
  // Age in Days = (Now - FirstSeen) / 1 Day in ms
  // Decay Factor = 0.95 - (Age in Days * 0.01)
  // Floor at 0.5
  // Decayed Count = count * decay
  //
  // Prune the long tail of statistically insignificant data
  // (this ensures that when we cut at 50% of total requested
  // pubkeys for level 6 popularity, we had already removed
  // the noise):
  // Decrement Value = 0.01% of max_count (min 1)
  //
  // New Count = min(Decayed Count, count - Decrement Value)
  // delete if New Count <= 0
  const fn = `
      let now = context.now;
      let max_count = context.maxCount;
      let age_ms = now - doc.firstSeenAt;
      let age_days = age_ms / 86400000.0;

      let decay = 0.95 - (age_days * 0.01);
      if decay < 0.5 { decay = 0.5; }

      let decayed_count = (doc.count * decay).floor();
      let decrement_value = (max_count * 0.0001).floor();
      if decrement_value == 0 { decrement_value = 1; }

      let new_count = decayed_count;
      if (doc.count - decrement_value) < new_count {
        new_count = doc.count - decrement_value;
      }

      if new_count <= 0 {
        doc = ();
      } else {
        doc.count = new_count;
      }
      doc
  `

  // Filter: Ignore Newcomers (Grace Period 2 Hours)
  // We only decay "established" keys.
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000)
  const filter = `firstSeenAt < ${twoHoursAgo}`

  try {
    console.log('Decay task enqueued...')
    const task = await index.updateDocumentsByFunction({
      function: fn,
      filter,
      context: {
        now: Date.now(),
        maxCount
      }
    })
    console.log(`Decay task ${task.uid} done with status "${task.status}"`)
  } catch (err) {
    const isNotFound = err.code === 'index_not_found' || err.cause?.code === 'index_not_found'
    if (isNotFound) {
      console.log('requestedPubkeys index not found, skipping decay.')
      return
    }
    console.error('Failed to run decay:', err)
  }
}

const config = {
  key: 'decayRequestedPubkeys',
  frequency: 4 * 60 * 60, // Run every 4 hours
  shouldUseLock: true,
  run
}

export default config
