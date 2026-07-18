import mdb from '#services/db/mdb.js'
import { loadAndMaybeRotateSketches } from '#services/event/tracker/mdb/requested-events.js'
import { eventKinds } from '#constants/event.js'
import { Buffer } from 'buffer'
import { queueDeleteEventsWithAccounting } from '#services/event/pending-workflows.js'

const BATCH_SIZE = 50

// Relay lists are essential infrastructure -- even unpopular real users'
// relay lists get fetched by their few friends.  Keep them with a minimal bar.
// Unified manifests are discoverable content and inherit the former listing
// retention policy. Relay lists remain outside the manifest capacity pool.
const CLEANUP_POLICIES = [
  {
    name: 'relay-lists',
    kinds: [eventKinds.READ_WRITE_RELAYS], // 10002
    gracePeriodSeconds: 60 * 60 * 24 * 3, // 3 days
    // if anyone fetched it in ~48h, keep it
    requestScoreThreshold: 1
  },
  {
    name: 'site-manifests',
    kinds: [eventKinds.MAIN_SITE_MANIFEST, eventKinds.NEXT_SITE_MANIFEST, eventKinds.DRAFT_SITE_MANIFEST],
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
        fields: ['ref', 'id', 'byteSize', 'pubkey', 'kind', 'ownerType', 'ip']
      })

      if (results.length === 0) break

      const candidates = []

      for (const hit of results) {
        const refBuf = Buffer.from(hit.ref)
        const score = sketchCurrent.estimate(refBuf) + sketchPrevious.estimate(refBuf)

        if (score <= policy.requestScoreThreshold) {
          candidates.push(hit)
        }
      }

      if (candidates.length > 0) {
        await queueDeleteEventsWithAccounting(candidates, {
          pruning: policy.name === 'site-manifests',
          source: 'deleteUnrequestedRelayEvents'
        })
        deletedCount += candidates.length
      }

      if (results.length < BATCH_SIZE) break
      offset += results.length
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
