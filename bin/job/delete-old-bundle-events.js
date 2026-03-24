import '#config/dotenv.js'
import mdb from '#services/db/mdb.js'

// Old "app bundle" kinds replaced by "site manifest" kinds (35128, 35129, 35130)
const OLD_KINDS = [37448, 37449, 37450]
const BATCH_SIZE = 100

async function run () {
  const kindFilter = OLD_KINDS.map(k => `kind = ${k}`).join(' OR ')
  let deleted = 0
  let offset = 0

  while (true) {
    const { results } = await mdb.index('events').getDocuments({
      filter: kindFilter,
      limit: BATCH_SIZE,
      offset,
      fields: ['ref']
    })
    if (results.length === 0) break

    const keys = results.map(e => e.ref)
    await mdb.index('events').deleteDocuments(keys)
    deleted += keys.length
    console.log(`Deleted ${deleted} events so far...`)

    if (results.length < BATCH_SIZE) break
    // No offset bump needed — deleted docs shift the window
  }

  console.log(`Done. Deleted ${deleted} events with old app bundle kinds (${OLD_KINDS.join(', ')}).`)
  process.exit(0)
}

run().catch(err => {
  console.error('Failed:', err)
  process.exit(1)
})
