import mdb from '#services/db/mdb.js'
import { primaryKeyToIp } from '#helpers/mdb.js'

const BATCH_SIZE = 100

async function run () {
  console.log('Running usedBytes reconciliation...')

  let offset = 0
  let ownersProcessed = 0

  while (true) {
    const { results } = await mdb.index('storedEventOwners').getDocuments({
      offset,
      limit: BATCH_SIZE,
      sort: ['key:asc']
    })

    if (results.length === 0) break

    for (const owner of results) {
      const { key, entityType } = owner

      // Sum actual event sizes for this owner
      let actualUsedBytes = 0
      let evOffset = 0

      while (true) {
        const filterValue = entityType === 'pubkey' ? key : primaryKeyToIp(key)
        const filter = entityType === 'pubkey'
          ? `pubkey = ${mdb.toMeiliValue(filterValue)} AND ownerType = "pubkey"`
          : `ip = ${mdb.toMeiliValue(filterValue)} AND ownerType = "ip"`

        // Use getDocuments() instead of search() to bypass maxTotalHits limitation
        const { results: evResults } = await mdb.index('events').getDocuments({
          filter,
          limit: BATCH_SIZE,
          offset: evOffset,
          fields: ['ref', 'byteSize']
        })

        if (evResults.length === 0) break

        for (const ev of evResults) {
          actualUsedBytes += (ev.byteSize || 0)
        }

        if (evResults.length < BATCH_SIZE) break
        evOffset += evResults.length
      }

      const oldUsedBytes = owner.usedBytes || 0
      if (oldUsedBytes !== actualUsedBytes) {
        console.log(`Reconciling ${entityType} ${key}: ${oldUsedBytes} -> ${actualUsedBytes} (diff: ${actualUsedBytes - oldUsedBytes})`)
        await mdb.index('storedEventOwners').updateDocuments([{
          key,
          usedBytes: actualUsedBytes
        }])
      }

      ownersProcessed++
    }

    offset += BATCH_SIZE
    console.log(`Reconciled ${ownersProcessed} owners...`)
  }

  console.log(`Reconciliation complete. Processed ${ownersProcessed} owners.`)
}

const config = {
  key: 'reconcileUsedBytes',
  frequency: 60 * 60 * 24, // Not used
  manual: true, // Manual trigger only
  shouldUseLock: true,
  run
}

export default config
