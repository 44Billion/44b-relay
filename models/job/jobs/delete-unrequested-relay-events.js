import mdb from '#services/db/mdb.js'
import { queueOps } from '#services/event/maintainer/mdb/index.js'
import { loadAndMaybeRotateSketches } from '#services/event/tracker/mdb/requested-events.js'
import { eventKinds } from '#constants/event.js'
import { Buffer } from 'buffer'

const BATCH_SIZE = 50

// Relay lists are essential infrastructure -- even unpopular real users'
// relay lists get fetched by their few friends.  Keep them with a minimal bar.
// App listings are discoverable content -- unpopular apps are fine to clean up,
// but they deserve more time to be discovered first.
const CLEANUP_POLICIES = [
  {
    name: 'relay-lists',
    kinds: [eventKinds.READ_WRITE_RELAYS], // 10002
    gracePeriodSeconds: 60 * 60 * 24 * 3, // 3 days
    // if anyone fetched it in ~48h, keep it
    requestScoreThreshold: 1
  },
  {
    name: 'app-listings',
    kinds: [eventKinds.MAIN_APP_LISTING, eventKinds.NEXT_APP_LISTING, eventKinds.DRAFT_APP_LISTING],
    // temporarily set to 1 year while we're beta testing
    gracePeriodSeconds: 60 * 60 * 24 * 365, // 60 * 60 * 24 * 7, // 7 days
    requestScoreThreshold: 5
  }
]

async function deleteUnrequestedRelayEvents () {
  let sketchCurrent, sketchPrevious
  try {
    ({ sketchCurrent, sketchPrevious } = await loadAndMaybeRotateSketches())
  } catch (err) {
    if (err.code === 'document_not_found' || err.cause?.code === 'document_not_found') return
    console.error('deleteUnrequestedRelayEvents: Failed to load sketch state', err)
    return
  }

  for (const policy of CLEANUP_POLICIES) {
    const receivedBefore = Math.floor(Date.now() / 1000) - policy.gracePeriodSeconds
    const kindFilter = policy.kinds.map(k => `kind = ${k}`).join(' OR ')
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

        if (score <= policy.requestScoreThreshold) {
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
      console.log(`Queued ${deletedCount} unrequested ${policy.name} for deletion`)
    }
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
