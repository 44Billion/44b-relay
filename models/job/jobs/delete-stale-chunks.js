import mdb from '#services/db/mdb.js'
import { queueOps } from '#services/event/maintainer/mdb/index.js'
import { eventKinds } from '#constants/event.js'

const BATCH_SIZE = 100
// Skip chunks uploaded less than 3 days ago, as the referencing
// events (e.g. bundle events) may not have been published yet.
const GRACE_PERIOD_SECONDS = 60 * 60 * 24 * 3

// Collect all file root hashes from bundle events authored by a specific pubkey.
async function collectBundleRootHashesForPubkey (pubkey) {
  const rootXSet = new Set()
  const kindFilter = [
    eventKinds.MAIN_APP_BUNDLE,
    eventKinds.NEXT_APP_BUNDLE,
    eventKinds.DRAFT_APP_BUNDLE
  ].map(k => `kind = ${k}`).join(' OR ')

  let offset = 0
  while (true) {
    const { results } = await mdb.index('events').getDocuments({
      filter: `(${kindFilter}) AND pubkey = ${mdb.toMeiliValue(pubkey)}`,
      limit: BATCH_SIZE,
      offset,
      fields: ['nonIndexableTags']
    })
    if (results.length === 0) break

    for (const hit of results) {
      if (!hit.nonIndexableTags) continue
      for (const tag of hit.nonIndexableTags) {
        if (tag[0] === 'file' && tag[1]) rootXSet.add(tag[1])
      }
    }

    if (results.length < BATCH_SIZE) break
    offset += results.length
  }

  return rootXSet
}

// Extract rootX values from a chunk's c tags.
// Checks both indexableTags (indexed single-letter `c` tags) and
// nonIndexableTags (overflow c tags beyond the 10-tag index limit).
function extractRootXFromChunk (hit) {
  const rootXSet = new Set()

  for (const tag of (hit.indexableTags || [])) {
    if (!tag.startsWith('c ')) continue
    const value = tag.slice(2) // "c rootX:index" → "rootX:index"
    const colonIdx = value.indexOf(':')
    if (colonIdx <= 0) continue
    rootXSet.add(value.slice(0, colonIdx))
  }

  for (const tag of (hit.nonIndexableTags || [])) {
    if (tag[0] !== 'c' || !tag[1]) continue
    const value = tag[1]
    const colonIdx = value.indexOf(':')
    if (colonIdx <= 0) continue
    rootXSet.add(value.slice(0, colonIdx))
  }

  return rootXSet
}

// Check whether a rootX (file root hash) is referenced via `r` tags
// on events by the same pubkey. Cache is scoped per-pubkey by the caller.
async function isRootXReferencedByRTag (rootX, pubkey, cache) {
  const cached = cache.get(rootX)
  if (cached !== undefined) return cached

  const { estimatedTotalHits } = await mdb.index('events').search('', {
    filter: `indexableTags = ${mdb.toMeiliValue('r ' + rootX)} AND pubkey = ${mdb.toMeiliValue(pubkey)}`,
    limit: 0
  })

  const referenced = estimatedTotalHits > 0
  cache.set(rootX, referenced)
  return referenced
}

async function deleteStaleChunks () {
  const receivedBefore = Math.floor(Date.now() / 1000) - GRACE_PERIOD_SECONDS
  const baseFilter = `kind = ${eventKinds.BINARY_DATA_CHUNK} AND ownerType = "pubkey" AND receivedAt <= ${receivedBefore}`

  // First pass: collect distinct pubkeys with stale chunks.
  // Only fetches the pubkey field, so memory is just a set of 64-char hex strings.
  const pubkeys = new Set()
  {
    let offset = 0
    while (true) {
      const { results } = await mdb.index('events').getDocuments({
        filter: baseFilter,
        limit: BATCH_SIZE,
        offset,
        fields: ['pubkey']
      })
      if (results.length === 0) break
      for (const hit of results) {
        if (hit.pubkey) pubkeys.add(hit.pubkey)
      }
      if (results.length < BATCH_SIZE) break
      offset += results.length
    }
  }

  console.log(`Found ${pubkeys.size} pubkeys with stale chunks`)

  let deletedCount = 0

  // Process one pubkey at a time to bound memory usage.
  // Bundle rootX set and r-tag cache are discarded after each pubkey.
  for (const pubkey of pubkeys) {
    const bundleRootXSet = await collectBundleRootHashesForPubkey(pubkey)
    const rTagCache = new Map() // rootX → boolean, scoped to this pubkey

    let offset = 0
    let usageDelta = 0

    while (true) {
      const { results } = await mdb.index('events').getDocuments({
        filter: `${baseFilter} AND pubkey = ${mdb.toMeiliValue(pubkey)}`,
        limit: BATCH_SIZE,
        offset,
        fields: ['ref', 'byteSize', 'indexableTags', 'nonIndexableTags']
      })
      if (results.length === 0) break

      const ops = []

      for (const hit of results) {
        const rootXSet = extractRootXFromChunk(hit)

        let isReferenced = false
        for (const rootX of rootXSet) {
          if (bundleRootXSet.has(rootX)) {
            isReferenced = true
            break
          }
          if (await isRootXReferencedByRTag(rootX, pubkey, rTagCache)) {
            isReferenced = true
            break
          }
        }

        if (isReferenced) continue

        ops.push({
          type: 'deleteDocumentIfExists',
          data: { index: 'events', key: hit.ref }
        })
        usageDelta -= (hit.byteSize || 0)
      }

      if (ops.length > 0) {
        await queueOps(ops)
        deletedCount += ops.length
      }

      if (results.length < BATCH_SIZE) break
      offset += results.length
    }

    if (usageDelta < 0) {
      await queueOps([{
        type: 'deltaUsage',
        data: { key: pubkey, delta: usageDelta, entityType: 'pubkey' }
      }])
    }
  }

  console.log(`Queued ${deletedCount} stale chunks for deletion`)
}

export async function run () {
  console.log('Running deleteStaleChunks job...')
  await deleteStaleChunks()
  console.log('Done deleteStaleChunks job.')
}

const config = {
  key: 'deleteStaleChunks',
  frequency: 60 * 60 * 24, // 1 day
  shouldUseLock: true,
  run
}

export default config
