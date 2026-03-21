import '#config/dotenv.js'
import mdb from '#services/db/mdb.js'
import { toHashtagStatsKey, isValidPrimaryKey } from '#helpers/mdb.js'

const BATCH_SIZE = 100

async function run () {
  // Phase A: Fix stuck pending ops with invalid hashtagStats keys
  console.log('--- Phase A: Fixing pending mergeHashtagStats ops ---')
  let opsFixed = 0
  let opsScanned = 0
  let offset = 0

  while (true) {
    const { hits } = await mdb.index('pendingOps').search('', {
      filter: "type = 'mergeHashtagStats'",
      limit: BATCH_SIZE,
      offset
    })
    if (hits.length === 0) break

    const updates = []
    for (const op of hits) {
      opsScanned++
      const data = op.data
      if (!data?.lang || !data?.tag) continue

      const newKey = toHashtagStatsKey(data.lang, data.tag)
      if (data.key !== newKey) {
        updates.push({ key: op.key, data: { ...data, key: newKey } })
        opsFixed++
      }
    }

    if (updates.length > 0) {
      await mdb.index('pendingOps').updateDocuments(updates)
    }

    offset += hits.length
    if (hits.length < BATCH_SIZE) break
  }

  console.log(`  Scanned ${opsScanned} pending ops, fixed ${opsFixed} keys.`)

  // Phase B: Migrate existing hashtagStats documents to new key format
  console.log('\n--- Phase B: Migrating existing hashtagStats documents ---')
  let docsScanned = 0
  let docsMigrated = 0
  let docsSkipped = 0
  offset = 0

  while (true) {
    const { results } = await mdb.index('hashtagStats').getDocuments({
      limit: BATCH_SIZE,
      offset
    })
    if (results.length === 0) break

    const newDocs = []
    const oldKeys = []

    for (const doc of results) {
      docsScanned++
      if (!doc.lang || !doc.tag) {
        docsSkipped++
        continue
      }

      const newKey = toHashtagStatsKey(doc.lang, doc.tag)
      if (doc.key === newKey) {
        docsSkipped++
        continue
      }

      if (!isValidPrimaryKey(doc.key)) {
        console.log(`  Invalid key found: "${doc.key}" -> "${newKey}"`)
      }

      newDocs.push({ ...doc, key: newKey })
      oldKeys.push(doc.key)
      docsMigrated++
    }

    // Add new docs first, then delete old ones (safe ordering)
    if (newDocs.length > 0) {
      await mdb.index('hashtagStats').addDocuments(newDocs)
    }
    if (oldKeys.length > 0) {
      await mdb.index('hashtagStats').deleteDocuments(oldKeys)
    }

    offset += results.length - oldKeys.length // deleted docs shift the offset
    if (results.length < BATCH_SIZE) break
  }

  console.log(`  Scanned ${docsScanned} documents, migrated ${docsMigrated}, skipped ${docsSkipped}.`)
  console.log('\nDone.')
  process.exit(0)
}

run().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
