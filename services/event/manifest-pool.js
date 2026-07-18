import mdb from '#services/db/mdb.js'
import { MANIFEST_KINDS } from '#constants/event.js'
import { patchJobByKey, putJobByKey } from '#models/job/dao.js'
import crypto from 'node:crypto'

const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024

export const MANIFEST_POOL_LIMITS = Object.freeze({
  global: Object.freeze({
    nominal: 2 * GIB,
    target: Math.floor(1.8 * GIB),
    emergency: Math.floor(2.2 * GIB)
  }),
  author: Object.freeze({
    nominal: 10 * MIB,
    target: 9 * MIB,
    emergency: 11 * MIB
  })
})

const GLOBAL_KEY = 'global'
const authorKey = pubkey => `author_${pubkey}`

export function isManifestKind (kind) {
  return MANIFEST_KINDS.has(kind)
}

function emptyCounter (key, pubkey = null) {
  return {
    key,
    scope: pubkey ? 'author' : 'global',
    ...(pubkey && { pubkey }),
    logicalBytes: 0,
    manifestCount: 0,
    pruningCount: 0,
    rejectionCount: 0,
    reconciledAt: 0,
    reservationTokens: []
  }
}

async function getCounter (key, pubkey = null) {
  try {
    const counter = await mdb.index('manifestPoolUsage').getDocument(key)
    if (!Array.isArray(counter.reservationTokens)) {
      await mdb.index('manifestPoolUsage').updateDocuments([{ key, reservationTokens: [] }])
      counter.reservationTokens = []
    }
    return counter
  } catch (error) {
    if (error.code !== 'document_not_found' && error.cause?.code !== 'document_not_found') throw error
    await mdb.index('manifestPoolUsage').addDocuments([emptyCounter(key, pubkey)])
    return mdb.index('manifestPoolUsage').getDocument(key)
  }
}

async function editCounter ({ key, pubkey, deltaBytes, deltaCount, emergency = null }) {
  if (deltaBytes === 0 && deltaCount === 0) return true
  await getCounter(key, pubkey)
  const reservationToken = deltaBytes > 0 ? crypto.randomUUID() : ''
  await mdb.index('manifestPoolUsage').updateDocumentsByFunction({
    function: `
      let next_bytes = doc.logicalBytes + context.deltaBytes;
      let allowed = context.deltaBytes <= 0 || context.emergency < 0 || next_bytes <= context.emergency;
      if allowed {
        if next_bytes < 0 { next_bytes = 0; }
        let next_count = doc.manifestCount + context.deltaCount;
        if next_count < 0 { next_count = 0; }
        doc.logicalBytes = next_bytes;
        doc.manifestCount = next_count;
        if context.reservationToken != "" {
          doc.reservationTokens.push(context.reservationToken);
        }
      }
      doc
    `,
    filter: `key = ${mdb.toMeiliValue(key)}`,
    context: { deltaBytes, deltaCount, emergency: emergency ?? -1, reservationToken }
  })
  if (!reservationToken) return true

  const counter = await getCounter(key, pubkey)
  const accepted = counter.reservationTokens.includes(reservationToken)
  if (accepted) {
    // Keep concurrent reservation markers while removing this completed one.
    await mdb.index('manifestPoolUsage').updateDocumentsByFunction({
      function: `
        let tokens = [];
        for token in doc.reservationTokens {
          if token != context.reservationToken { tokens.push(token); }
        }
        doc.reservationTokens = tokens;
        doc
      `,
      filter: `key = ${mdb.toMeiliValue(key)}`,
      context: { reservationToken }
    })
  }
  return accepted
}

async function incrementMetric (key, pubkey, field, delta = 1) {
  if (!['pruningCount', 'rejectionCount'].includes(field)) throw new TypeError('Unknown manifest pool metric')
  await getCounter(key, pubkey)
  await mdb.index('manifestPoolUsage').updateDocumentsByFunction({
    function: `doc.${field} = doc.${field} + context.delta; doc`,
    filter: `key = ${mdb.toMeiliValue(key)}`,
    context: { delta }
  })
}

async function requestCapacityPruning () {
  const requestedAt = Math.floor(Date.now() / 1000)
  const result = await patchJobByKey('pruneManifestPool', { requestedAt })
  if (result.success) return
  if (result.error?.code !== 'document_not_found') throw result.error
  const created = await putJobByKey('pruneManifestPool', { startedAt: 0, endedAt: 0, requestedAt })
  if (!created.success) throw created.error
}

// Atomically reserves the positive or negative replacement delta against the
// global counter and then the author's counter. A failed second reservation is
// rolled back from the first counter.
export async function reserveManifestCapacity ({ pubkey, newBytes, oldBytes = 0, isReplacement = false }) {
  const deltaBytes = newBytes - oldBytes
  const deltaCount = isReplacement ? 0 : 1
  const globalAccepted = await editCounter({
    key: GLOBAL_KEY,
    deltaBytes,
    deltaCount,
    emergency: MANIFEST_POOL_LIMITS.global.emergency
  })
  if (!globalAccepted) {
    await incrementMetric(GLOBAL_KEY, null, 'rejectionCount')
    return { accepted: false, reason: 'global manifest pool emergency limit reached' }
  }

  const perAuthorAccepted = await editCounter({
    key: authorKey(pubkey),
    pubkey,
    deltaBytes,
    deltaCount,
    emergency: MANIFEST_POOL_LIMITS.author.emergency
  })
  if (!perAuthorAccepted) {
    await editCounter({ key: GLOBAL_KEY, deltaBytes: -deltaBytes, deltaCount: -deltaCount })
    await incrementMetric(GLOBAL_KEY, null, 'rejectionCount')
    await incrementMetric(authorKey(pubkey), pubkey, 'rejectionCount')
    return { accepted: false, reason: 'author manifest pool emergency limit reached' }
  }

  const [global, author] = await Promise.all([
    getCounter(GLOBAL_KEY),
    getCounter(authorKey(pubkey), pubkey)
  ])
  if (global.logicalBytes > MANIFEST_POOL_LIMITS.global.nominal ||
      author.logicalBytes > MANIFEST_POOL_LIMITS.author.nominal) {
    requestCapacityPruning().catch(error => console.error('Failed to schedule manifest pool pruning', error))
  }
  return { accepted: true, deltaBytes, deltaCount }
}

export async function cancelManifestReservation (pubkey, reservation) {
  if (!reservation?.accepted) return
  await Promise.all([
    editCounter({ key: GLOBAL_KEY, deltaBytes: -reservation.deltaBytes, deltaCount: -reservation.deltaCount }),
    editCounter({ key: authorKey(pubkey), pubkey, deltaBytes: -reservation.deltaBytes, deltaCount: -reservation.deltaCount })
  ])
}

export async function releaseManifestUsage ({ pubkey, logicalBytes, count = 1, pruning = false }) {
  await Promise.all([
    editCounter({ key: GLOBAL_KEY, deltaBytes: -logicalBytes, deltaCount: -count }),
    editCounter({ key: authorKey(pubkey), pubkey, deltaBytes: -logicalBytes, deltaCount: -count })
  ])
  if (pruning) {
    await Promise.all([
      incrementMetric(GLOBAL_KEY, null, 'pruningCount'),
      incrementMetric(authorKey(pubkey), pubkey, 'pruningCount')
    ])
  }
}

// Releases a successfully deleted batch with one global counter mutation and
// one mutation per affected author. This keeps capacity pruning bounded even
// when it removes many small manifests.
export async function releaseManifestBatch (events, { pruning = false } = {}) {
  if (!events.length) return
  const byAuthor = new Map()
  let logicalBytes = 0
  for (const event of events) {
    const bytes = event.byteSize || 0
    logicalBytes += bytes
    const usage = byAuthor.get(event.pubkey) || { logicalBytes: 0, count: 0 }
    usage.logicalBytes += bytes
    usage.count++
    byAuthor.set(event.pubkey, usage)
  }

  const mutations = [
    editCounter({ key: GLOBAL_KEY, deltaBytes: -logicalBytes, deltaCount: -events.length })
  ]
  for (const [pubkey, usage] of byAuthor) {
    mutations.push(editCounter({
      key: authorKey(pubkey),
      pubkey,
      deltaBytes: -usage.logicalBytes,
      deltaCount: -usage.count
    }))
  }
  await Promise.all(mutations)

  if (pruning) {
    const metrics = [incrementMetric(GLOBAL_KEY, null, 'pruningCount', events.length)]
    for (const [pubkey, usage] of byAuthor) {
      metrics.push(incrementMetric(authorKey(pubkey), pubkey, 'pruningCount', usage.count))
    }
    await Promise.all(metrics)
  }
}

export async function getManifestPoolUsage () {
  const global = await getCounter(GLOBAL_KEY)
  const authors = []
  let offset = 0
  while (true) {
    const { results } = await mdb.index('manifestPoolUsage').getDocuments({
      filter: 'scope = "author"',
      limit: 500,
      offset,
      sort: ['logicalBytes:desc']
    })
    authors.push(...results)
    if (results.length < 500) break
    offset += results.length
  }
  return { global, authors }
}

// Rebuilds logical counters from the events index, which is the source of
// truth after crashes, partial queue processing, or cross-process races.
export async function reconcileManifestPoolUsage () {
  const kindFilter = [...MANIFEST_KINDS].map(kind => `kind = ${kind}`).join(' OR ')
  const byAuthor = new Map()
  let globalBytes = 0
  let globalCount = 0
  let offset = 0
  while (true) {
    const { results } = await mdb.index('events').getDocuments({
      filter: `(${kindFilter})`,
      fields: ['pubkey', 'byteSize'],
      limit: 500,
      offset
    })
    for (const event of results) {
      const bytes = event.byteSize || 0
      globalBytes += bytes
      globalCount++
      const current = byAuthor.get(event.pubkey) || { bytes: 0, count: 0 }
      current.bytes += bytes
      current.count++
      byAuthor.set(event.pubkey, current)
    }
    if (results.length < 500) break
    offset += results.length
  }

  const now = Math.floor(Date.now() / 1000)
  let usedDatabaseSize = null
  try {
    const stats = await mdb.getStats()
    usedDatabaseSize = stats.usedDatabaseSize ?? stats.databaseSize ?? null
  } catch (_) {}

  const previousGlobal = await getCounter(GLOBAL_KEY)
  const documents = [{
    ...emptyCounter(GLOBAL_KEY),
    pruningCount: previousGlobal.pruningCount || 0,
    rejectionCount: previousGlobal.rejectionCount || 0,
    logicalBytes: globalBytes,
    manifestCount: globalCount,
    usedDatabaseSize,
    reconciledAt: now
  }]
  for (const [pubkey, usage] of byAuthor) {
    let previous = emptyCounter(authorKey(pubkey), pubkey)
    try { previous = await mdb.index('manifestPoolUsage').getDocument(authorKey(pubkey)) } catch (_) {}
    documents.push({
      ...emptyCounter(authorKey(pubkey), pubkey),
      pruningCount: previous.pruningCount || 0,
      rejectionCount: previous.rejectionCount || 0,
      logicalBytes: usage.bytes,
      manifestCount: usage.count,
      reconciledAt: now
    })
  }
  await mdb.index('manifestPoolUsage').deleteDocuments({ filter: 'scope = "author"' })
  await mdb.index('manifestPoolUsage').addDocuments(documents)
  console.log('Manifest pool usage', {
    logicalBytes: globalBytes,
    manifestCount: globalCount,
    usedDatabaseSize
  })
  return { global: documents[0], authors: documents.slice(1) }
}

export { authorKey, GLOBAL_KEY }
