import mdb from '#services/db/mdb.js'

export async function run () {
  console.log('Running hashtag stats decay...')
  const index = mdb.index('hashtagStats')

  // Decay tag documents: reduce count and neighbor counts,
  // prune weak neighbors, delete docs with count <= 0
  const tagFn = `
      let now = context.now;
      let age_ms = now - doc.updatedAt;
      let age_hours = age_ms / 3600000.0;

      let decay = 0.97 - (age_hours * 0.0001);
      if decay < 0.5 { decay = 0.5; }

      doc.count = (doc.count * decay).floor();

      if doc.count <= 0 {
          doc = ();
      } else {
          // Decay neighbors
          if doc.neighbors != () {
              let new_neighbors = [];
              for pair in doc.neighbors {
                  let tag = pair[0];
                  let cnt = (pair[1] * decay).floor();
                  if cnt > 0 {
                      new_neighbors.push([tag, cnt]);
                  }
              }
              doc.neighbors = new_neighbors;
          }
          doc.updatedAt = now;
      }
      doc
  `

  // Only decay tag docs that haven't been updated very recently (grace period: 2 hours)
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000)
  const tagFilter = `docType = "tag" AND updatedAt < ${twoHoursAgo}`

  try {
    console.log('Hashtag stats (tag) decay task enqueued...')
    const task = await index.updateDocumentsByFunction({
      function: tagFn,
      filter: tagFilter,
      context: { now: Date.now() }
    })
    console.log(`Hashtag stats decay task ${task.uid} done with status "${task.status}"`)
  } catch (err) {
    const isNotFound = err.code === 'index_not_found' || err.cause?.code === 'index_not_found'
    if (isNotFound) {
      console.log('hashtagStats index not found, skipping decay.')
      return
    }
    console.error('Failed to run hashtag stats decay:', err)
  }
}

const config = {
  key: 'decayHashtagStats',
  frequency: 6 * 60 * 60, // Run every 6 hours
  shouldUseLock: true,
  run
}

export default config
