import mdb from '#services/db/mdb.js'
import { queueOps } from '#services/event/maintainer/mdb/index.js'
import { loadAndMaybeRotateSketches } from '#services/event/tracker/mdb/requested-events.js'
import { RELAY_OWNED_KINDS } from '#constants/event.js'
import { Buffer } from 'buffer'

const BATCH_SIZE = 50
// Skip events uploaded less than 3 days ago to give them time
// to be discovered and requested across at least one full
// sliding window cycle (48h).
const GRACE_PERIOD_SECONDS = 60 * 60 * 24 * 3
// Events with a combined CMS score (current + previous window)
// at or below this threshold are considered unrequested.
const REQUEST_SCORE_THRESHOLD = 5

async function deleteUnrequestedRelayEvents () {
  let sketchCurrent, sketchPrevious
  try {
    ({ sketchCurrent, sketchPrevious } = await loadAndMaybeRotateSketches())
  } catch (err) {
    if (err.code === 'document_not_found' || err.cause?.code === 'document_not_found') return
    console.error('deleteUnrequestedRelayEvents: Failed to load sketch state', err)
    return
  }

  const receivedBefore = Math.floor(Date.now() / 1000) - GRACE_PERIOD_SECONDS
  const kindFilter = [...RELAY_OWNED_KINDS].map(k => `kind = ${k}`).join(' OR ')
  const baseFilter = `(${kindFilter}) AND receivedAt <= ${receivedBefore}`

  let offset = 0
  let deletedCount = 0

  while (true) {
    const { results } = await mdb.index('events').getDocuments({
      filter: baseFilter,
      limit: BATCH_SIZE,
      offset,
      fields: ['ref', 'byteSize']
    })

    if (results.length === 0) break

    const ops = []
    let batchDeleted = 0

    for (const hit of results) {
      const refBuf = Buffer.from(hit.ref)
      const score = sketchCurrent.estimate(refBuf) + sketchPrevious.estimate(refBuf)

      if (score <= REQUEST_SCORE_THRESHOLD) {
        ops.push({
          type: 'deleteDocumentIfExists',
          data: { index: 'events', key: hit.ref }
        })
        batchDeleted++
      }
    }

    if (ops.length > 0) {
      await queueOps(ops)
      deletedCount += batchDeleted
    }

    if (results.length < BATCH_SIZE) break
    offset += (results.length - batchDeleted)
  }

  if (deletedCount > 0) {
    console.log(`Queued ${deletedCount} unrequested relay-owned events for deletion`)
  }
}

export async function run () {
  console.log('Running deleteUnrequestedRelayEvents job...')
  await deleteUnrequestedRelayEvents()
  console.log('Done deleteUnrequestedRelayEvents job.')
}

const config = {
  key: 'deleteUnrequestedRelayEvents',
  frequency: 60 * 60 * 6, // 6 hours
  shouldUseLock: true,
  run
}

export default config
