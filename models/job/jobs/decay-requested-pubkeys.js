import mdb from '#services/db/mdb.js'

export async function run () {
  console.log('Running requested pubkeys decay...')
  const index = mdb.index('requestedPubkeys')

  // Rhai script to decay older documents more significantly
  // Formula:
  // Age in Days = (Now - FirstSeen) / 1 Day in ms
  // Decay Factor = 0.95 - (Age in Days * 0.01)
  // Floor at 0.5
  const fn = `
      let now = context.now;
      let age_ms = now - doc.firstSeenAt;
      let age_days = age_ms / 86400000.0;

      let decay = 0.95 - (age_days * 0.01);

      if decay < 0.5 { decay = 0.5; }

      doc.count = (doc.count * decay).floor();
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
      context: { now: Date.now() }
    })
    console.log(`Decay task ${task.uid} done with status "${status}"`)
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
