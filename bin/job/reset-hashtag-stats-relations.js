import '#config/dotenv.js'
import mdb from '#services/db/mdb.js'

const BATCH_SIZE = 100

async function run () {
  let offset = 0
  let total = 0

  while (true) {
    const { results } = await mdb.index('hashtagStats').getDocuments({
      limit: BATCH_SIZE,
      offset,
      fields: ['key']
    })
    if (results.length === 0) break

    await mdb.index('hashtagStats').updateDocuments(results.map(r => ({
      key: r.key,
      neighbors: [],
      embedding: null,
      embeddingHash: null
    })))

    total += results.length
    offset += BATCH_SIZE
    console.log(`Reset ${total} documents...`)
  }

  console.log(`Done. Reset neighbors/embeddings on ${total} hashtagStats documents.`)
  process.exit(0)
}

run().catch(err => {
  console.error('Failed:', err)
  process.exit(1)
})
