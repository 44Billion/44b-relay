import mdb from '#services/db/mdb.js'
import { MANIFEST_KINDS } from '#constants/event.js'
import { deriveBlobRefs, recordToEvent } from '#models/event/mapper.js'
import reconcileUsedBytesConfig from './reconcile-used-bytes.js'
import { reconcileManifestPoolUsage } from '#services/event/manifest-pool.js'
import { pruneManifestPool } from './prune-manifest-pool.js'

const LEGACY_LISTING_KINDS = [37348, 37349, 37350]
const BATCH_SIZE = 100
const COMPLETION_KEY = 'migrateIrfsV2-complete'
const ALL_KINDS = [...LEGACY_LISTING_KINDS, ...MANIFEST_KINDS]
const KIND_FILTER = ALL_KINDS.map(kind => `kind = ${kind}`).join(' OR ')
const TAG_RECORD_FIELDS = [
  'ref', 'id', 'kind', 'pubkey', 'created_at', 'sig',
  'indexableTags', 'indexableTagExtras', 'nonIndexableTags'
]

export function isLegacyIrfsManifest (event) {
  if (!MANIFEST_KINDS.has(event.kind)) return false
  const service = event.tags.find(tag => tag[0] === 'service')?.[1]
  if (service !== 'irfs') return false
  const hasLegacyPath = event.tags.some(tag => tag[0] === 'path')
  const hasV2Reference = event.tags.some(tag => tag[0] === 'r' && /^[0-9a-f]{64}$/.test(tag[1]))
  return hasLegacyPath || !hasV2Reference
}

export async function migrateIrfsV2 () {
  try {
    const completion = await mdb.index('maintenanceStates').getDocument(COMPLETION_KEY)
    if (completion.completedAt) return { alreadyCompleted: true, completedAt: completion.completedAt }
  } catch (error) {
    if (error.code !== 'document_not_found' && error.cause?.code !== 'document_not_found') throw error
  }

  let offset = 0
  let deletedListings = 0
  let deletedIrfsManifests = 0
  let migratedManifests = 0
  let backfilledBlobRefs = 0

  while (true) {
    const { results } = await mdb.index('events').getDocuments({
      filter: `(${KIND_FILTER})`,
      limit: BATCH_SIZE,
      offset,
      fields: TAG_RECORD_FIELDS
    })
    if (!results.length) break

    const toDelete = []
    const patches = []
    for (const record of results) {
      if (LEGACY_LISTING_KINDS.includes(record.kind)) {
        toDelete.push(record.ref)
        deletedListings++
        continue
      }

      const event = recordToEvent(record)
      if (isLegacyIrfsManifest(event)) {
        toDelete.push(record.ref)
        deletedIrfsManifests++
        continue
      }

      patches.push({
        ref: record.ref,
        blobRefs: deriveBlobRefs(event.tags),
        ownerType: 'pubkey',
        ip: null,
        popularityLevel: 999
      })
      migratedManifests++
    }

    if (toDelete.length) await mdb.index('events').deleteDocuments(toDelete)
    if (patches.length) await mdb.index('events').updateDocuments(patches)
    if (results.length < BATCH_SIZE) break
    offset += results.length - toDelete.length
  }

  offset = 0
  while (true) {
    const { results } = await mdb.index('events').getDocuments({
      limit: BATCH_SIZE,
      offset,
      fields: TAG_RECORD_FIELDS
    })
    if (!results.length) break
    const patches = []
    for (const record of results) {
      if (!record.ref || !Number.isInteger(record.kind)) continue
      patches.push({ ref: record.ref, blobRefs: deriveBlobRefs(recordToEvent(record).tags) })
    }
    if (patches.length) {
      await mdb.index('events').updateDocuments(patches)
      backfilledBlobRefs += patches.length
    }
    if (results.length < BATCH_SIZE) break
    offset += results.length
  }

  // Existing manifests used the ordinary per-owner accounting. Rebuild it
  // after reclassifying manifests, then initialize the new subsidized pool
  // from the events index and enforce both quotas immediately.
  await reconcileUsedBytesConfig.run()
  await reconcileManifestPoolUsage()
  const pruning = await pruneManifestPool()

  const result = { deletedListings, deletedIrfsManifests, migratedManifests, backfilledBlobRefs, pruning }
  await mdb.index('maintenanceStates').addDocuments([{
    key: COMPLETION_KEY,
    jobKey: 'migrateIrfsV2',
    completedAt: Math.floor(Date.now() / 1000)
  }])
  console.log('IRFS/MMR v2 relay migration complete', result)
  return result
}

export async function run () {
  console.log('Running migrateIrfsV2 job...')
  await migrateIrfsV2()
  console.log('Done migrateIrfsV2 job.')
}

export default {
  key: 'migrateIrfsV2',
  frequency: 60 * 60 * 24,
  manual: true,
  shouldUseLock: true,
  run
}
