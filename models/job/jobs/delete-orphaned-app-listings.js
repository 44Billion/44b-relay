import mdb from '#services/db/mdb.js'
import { queueOps } from '#services/event/maintainer/mdb/index.js'
import { eventKinds } from '#constants/event.js'

const BATCH_SIZE = 100
// Skip app listings received less than 3 days ago, as the corresponding
// site manifest event may not have been published yet.
const GRACE_PERIOD_SECONDS = 60 * 60 * 24 * 3

// Maps each app listing kind to its corresponding site manifest kind (same channel).
const APP_LISTING_TO_MANIFEST = {
  [eventKinds.MAIN_APP_LISTING]: eventKinds.MAIN_SITE_MANIFEST,
  [eventKinds.NEXT_APP_LISTING]: eventKinds.NEXT_SITE_MANIFEST,
  [eventKinds.DRAFT_APP_LISTING]: eventKinds.DRAFT_SITE_MANIFEST
}

const APP_LISTING_KINDS = Object.keys(APP_LISTING_TO_MANIFEST).map(Number)

// Collect all d-tag values from site manifest events for a specific pubkey and manifest kind.
async function collectManifestDTags (pubkey, manifestKind) {
  const dTags = new Set()
  let offset = 0

  while (true) {
    const { results } = await mdb.index('events').getDocuments({
      filter: `kind = ${manifestKind} AND pubkey = ${mdb.toMeiliValue(pubkey)}`,
      limit: BATCH_SIZE,
      offset,
      fields: ['indexableTags']
    })
    if (results.length === 0) break

    for (const hit of results) {
      if (!hit.indexableTags) continue
      for (const tag of hit.indexableTags) {
        if (tag.startsWith('d ')) dTags.add(tag.slice(2))
      }
    }

    if (results.length < BATCH_SIZE) break
    offset += results.length
  }

  return dTags
}

// Extract the d-tag value from an app listing's indexableTags.
function extractDTag (hit) {
  if (!hit.indexableTags) return null
  for (const tag of hit.indexableTags) {
    if (tag.startsWith('d ')) return tag.slice(2)
  }
  return null
}

async function deleteOrphanedAppListings () {
  const receivedBefore = Math.floor(Date.now() / 1000) - GRACE_PERIOD_SECONDS
  const kindFilter = APP_LISTING_KINDS.map(k => `kind = ${k}`).join(' OR ')
  const baseFilter = `(${kindFilter}) AND receivedAt <= ${receivedBefore}`

  // First pass: collect distinct pubkeys with stale app listings.
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

  console.log(`Found ${pubkeys.size} pubkeys with app listing events`)

  let deletedCount = 0

  // Process one pubkey at a time to bound memory usage.
  for (const pubkey of pubkeys) {
    // Pre-collect manifest d-tags for each channel for this pubkey.
    const manifestDTagsByListingKind = new Map()
    for (const [listingKind, manifestKind] of Object.entries(APP_LISTING_TO_MANIFEST)) {
      manifestDTagsByListingKind.set(
        Number(listingKind),
        await collectManifestDTags(pubkey, manifestKind)
      )
    }

    let offset = 0

    while (true) {
      const { results } = await mdb.index('events').getDocuments({
        filter: `${baseFilter} AND pubkey = ${mdb.toMeiliValue(pubkey)}`,
        limit: BATCH_SIZE,
        offset,
        fields: ['ref', 'kind', 'indexableTags']
      })
      if (results.length === 0) break

      const ops = []

      for (const hit of results) {
        const dTag = extractDTag(hit)
        if (dTag === null) continue

        const manifestDTags = manifestDTagsByListingKind.get(hit.kind)
        if (manifestDTags && manifestDTags.has(dTag)) continue

        ops.push({
          type: 'deleteDocumentIfExists',
          data: { index: 'events', key: hit.ref }
        })
      }

      if (ops.length > 0) {
        await queueOps(ops)
        deletedCount += ops.length
      }

      if (results.length < BATCH_SIZE) break
      offset += results.length
    }
  }

  console.log(`Queued ${deletedCount} orphaned app listings for deletion`)
}

export async function run () {
  console.log('Running deleteOrphanedAppListings job...')
  await deleteOrphanedAppListings()
  console.log('Done deleteOrphanedAppListings job.')
}

const config = {
  key: 'deleteOrphanedAppListings',
  frequency: 60 * 60 * 24, // 1 day
  shouldUseLock: true,
  run
}

export default config
