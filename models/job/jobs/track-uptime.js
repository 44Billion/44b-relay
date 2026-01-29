import mdb from '#services/db/mdb.js'

export async function run () {
  const now = Date.now()
  const currentHour = Math.floor(now / (1000 * 60 * 60))
  const key = `uptime-${currentHour}`
  const index = mdb.index('maintenanceStates')

  let doc
  try {
    doc = await index.getDocument(key)
  } catch (err) {
    if (err.code !== 'document_not_found' && err.cause?.code !== 'document_not_found') throw err
    doc = { key, count: 0, createdAt: now, type: 'uptime' }
  }

  doc.count = (doc.count || 0) + 1
  doc.updatedAt = now

  await index.addDocuments([doc])

  // Pruning: run occasionally (e.g., ~1/60 chance aka once an hour on average, or just deterministically)
  // Let's keep it simple: prune every time but only look for really old stuff?
  // Or just rely on search to find old documents.
  // To avoid performance hit on every minute, verify 'uptime-clean' key timestamp?
  // Let's just do a search query. It's fast (limit 50).
  const cutoff = now - (26 * 60 * 60 * 1000)

  try {
    // Filter documents older than 26 hours
    // using filterable attribute 'createdAt'.
    // We must manually check type/key client-side to be safe.
    const { hits: results } = await index.search('', {
      filter: `createdAt < ${cutoff}`,
      limit: 100
    })

    const toDelete = results
      .filter(d => d.key.startsWith('uptime-'))
      .map(d => d.key)

    if (toDelete.length > 0) {
      await index.deleteDocuments(toDelete)
    }
  } catch (err) {
    console.error('Failed to prune uptime stats:', err)
  }
}

const config = {
  key: 'trackUptime',
  frequency: 60, // Every minute
  shouldUseLock: true,
  run
}

export default config
