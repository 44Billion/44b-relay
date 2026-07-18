import mdb from '#services/db/mdb.js'
import { MANIFEST_KINDS } from '#constants/event.js'
import { patchJobByKey, putJobByKey } from '#models/job/dao.js'
import crypto from 'node:crypto'

const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024
const TERMINAL_RESERVATION_RETENTION_MS = 24 * 60 * 60 * 1000
const ORPHAN_RESERVATION_GRACE_MS = 60 * 1000

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
const COUNTER_ARRAY_FIELDS = Object.freeze([
  'reservationTokens',
  'settlementTokens',
  'metricTokens',
  'accountingTokens',
  'workflowTokens'
])
const COUNTER_NUMBER_FIELDS = Object.freeze([
  'logicalBytes',
  'manifestCount',
  'pruningCount',
  'rejectionCount',
  'reconciledAt',
  'mutationVersion'
])

export function isManifestKind (kind) {
  return MANIFEST_KINDS.has(kind)
}

async function getCounter (key, pubkey = null) {
  let counter
  try {
    counter = await mdb.index('manifestPoolUsage').getDocument(key)
  } catch (error) {
    if (error.code !== 'document_not_found' && error.cause?.code !== 'document_not_found') throw error
    // updateDocuments is a partial upsert. Concurrent creators therefore only
    // merge this identity and cannot replace counters already changed by a
    // reservation in another process.
    await mdb.index('manifestPoolUsage').updateDocuments([{
      key,
      scope: pubkey ? 'author' : 'global',
      ...(pubkey && { pubkey })
    }])
    counter = await mdb.index('manifestPoolUsage').getDocument(key)
  }

  const hasMissingField = COUNTER_NUMBER_FIELDS.some(field => !Number.isFinite(counter[field])) ||
    COUNTER_ARRAY_FIELDS.some(field => !Array.isArray(counter[field]))
  if (!hasMissingField) return counter

  // Initialize legacy/new partial documents atomically. A plain []/0 patch
  // could otherwise erase a token written between our read and update.
  await mdb.index('manifestPoolUsage').updateDocumentsByFunction({
    function: `
      if doc.logicalBytes == () { doc.logicalBytes = 0; }
      if doc.manifestCount == () { doc.manifestCount = 0; }
      if doc.pruningCount == () { doc.pruningCount = 0; }
      if doc.rejectionCount == () { doc.rejectionCount = 0; }
      if doc.reconciledAt == () { doc.reconciledAt = 0; }
      if doc.mutationVersion == () { doc.mutationVersion = 0; }
      if doc.reservationTokens == () { doc.reservationTokens = []; }
      if doc.settlementTokens == () { doc.settlementTokens = []; }
      if doc.metricTokens == () { doc.metricTokens = []; }
      if doc.accountingTokens == () { doc.accountingTokens = []; }
      if doc.workflowTokens == () { doc.workflowTokens = []; }
      doc
    `,
    filter: `key = ${mdb.toMeiliValue(key)}`
  })
  counter = await mdb.index('manifestPoolUsage').getDocument(key)
  for (const field of COUNTER_ARRAY_FIELDS) {
    if (!Array.isArray(counter[field])) throw new TypeError(`Invalid ${field} in manifest pool counter ${key}`)
  }
  return counter
}

function isNotFound (error) {
  return error?.code === 'document_not_found' || error?.cause?.code === 'document_not_found'
}

async function getReservation (reservationKey) {
  return mdb.index('manifestPoolReservations').getDocument(reservationKey)
}

async function patchReservation (reservationKey, patch) {
  await mdb.index('manifestPoolReservations').updateDocuments([{
    key: reservationKey,
    ...patch,
    updatedAt: Date.now()
  }])
  return getReservation(reservationKey)
}

async function reserveCounter ({ key, pubkey, token, deltaBytes, deltaCount, emergency }) {
  await getCounter(key, pubkey)
  await mdb.index('manifestPoolUsage').updateDocumentsByFunction({
    function: `
      let seen = false;
      for existing in doc.reservationTokens {
        if existing == context.token { seen = true; }
      }
      if !seen {
        let next_bytes = doc.logicalBytes + context.deltaBytes;
        let allowed = context.deltaBytes <= 0 || next_bytes <= context.emergency;
        if allowed {
          doc.logicalBytes = next_bytes;
          doc.manifestCount = doc.manifestCount + context.deltaCount;
          doc.reservationTokens.push(context.token);
          doc.mutationVersion = doc.mutationVersion + 1;
        }
      }
      doc
    `,
    filter: `key = ${mdb.toMeiliValue(key)}`,
    context: { token, deltaBytes, deltaCount, emergency }
  })
  return (await getCounter(key, pubkey)).reservationTokens.includes(token)
}

async function settleCounterReservation ({
  key, pubkey, reservationToken, settlementToken,
  reservedBytes, reservedCount, actualDeltaBytes = 0, actualDeltaCount = 0,
  outcome
}) {
  await getCounter(key, pubkey)
  await mdb.index('manifestPoolUsage').updateDocumentsByFunction({
    function: `
      let already_settled = false;
      for existing in doc.settlementTokens {
        if existing == context.settlementToken { already_settled = true; }
      }
      if !already_settled {
        let had_reservation = false;
        let remaining = [];
        for existing in doc.reservationTokens {
          if existing == context.reservationToken {
            had_reservation = true;
          } else {
            remaining.push(existing);
          }
        }
        if had_reservation {
          let delta_bytes = 0 - context.reservedBytes;
          let delta_count = 0 - context.reservedCount;
          if context.outcome == "commit" {
            delta_bytes = context.actualDeltaBytes - context.reservedBytes;
            delta_count = context.actualDeltaCount - context.reservedCount;
          }
          let next_bytes = doc.logicalBytes + delta_bytes;
          let next_count = doc.manifestCount + delta_count;
          if next_bytes < 0 { next_bytes = 0; }
          if next_count < 0 { next_count = 0; }
          doc.logicalBytes = next_bytes;
          doc.manifestCount = next_count;
          doc.reservationTokens = remaining;
          doc.settlementTokens.push(context.settlementToken);
          doc.mutationVersion = doc.mutationVersion + 1;
        }
      }
      doc
    `,
    filter: `key = ${mdb.toMeiliValue(key)}`,
    context: {
      reservationToken,
      settlementToken,
      reservedBytes,
      reservedCount,
      actualDeltaBytes,
      actualDeltaCount,
      outcome
    }
  })
  const counter = await getCounter(key, pubkey)
  const settled = counter.settlementTokens.includes(settlementToken)
  const reservationAbsent = !counter.reservationTokens.includes(reservationToken)
  // During a partially-created reservation, one counter may never have
  // received the token. Cancellation is already complete for that counter.
  return settled || (outcome === 'cancel' && reservationAbsent)
}

async function clearCounterToken (key, field, token) {
  if (!['settlementTokens', 'metricTokens', 'accountingTokens'].includes(field)) {
    throw new TypeError('Unknown manifest counter token field')
  }
  await mdb.index('manifestPoolUsage').updateDocumentsByFunction({
    function: `
      let remaining = [];
      for existing in doc.${field} {
        if existing != context.token { remaining.push(existing); }
      }
      doc.${field} = remaining;
      doc
    `,
    filter: `key = ${mdb.toMeiliValue(key)}`,
    context: { token }
  })
}

export async function beginManifestMutation (operationKey) {
  await getCounter(GLOBAL_KEY)
  await mdb.index('manifestPoolUsage').updateDocumentsByFunction({
    function: `
      let seen = false;
      for existing in doc.workflowTokens {
        if existing == context.token { seen = true; }
      }
      if !seen {
        doc.workflowTokens.push(context.token);
        doc.mutationVersion = doc.mutationVersion + 1;
      }
      doc
    `,
    filter: `key = ${mdb.toMeiliValue(GLOBAL_KEY)}`,
    context: { token: operationKey }
  })
}

export async function finishManifestMutation (operationKey) {
  await getCounter(GLOBAL_KEY)
  await mdb.index('manifestPoolUsage').updateDocumentsByFunction({
    function: `
      let seen = false;
      let remaining = [];
      for existing in doc.workflowTokens {
        if existing == context.token {
          seen = true;
        } else {
          remaining.push(existing);
        }
      }
      if seen {
        doc.workflowTokens = remaining;
        doc.mutationVersion = doc.mutationVersion + 1;
      }
      doc
    `,
    filter: `key = ${mdb.toMeiliValue(GLOBAL_KEY)}`,
    context: { token: operationKey }
  })
}

async function incrementMetricOnce ({ key, pubkey, field, delta = 1, token }) {
  if (!['pruningCount', 'rejectionCount'].includes(field)) throw new TypeError('Unknown manifest pool metric')
  await getCounter(key, pubkey)
  await mdb.index('manifestPoolUsage').updateDocumentsByFunction({
    function: `
      let seen = false;
      for existing in doc.metricTokens {
        if existing == context.token { seen = true; }
      }
      if !seen {
        doc.${field} = doc.${field} + context.delta;
        doc.metricTokens.push(context.token);
      }
      doc
    `,
    filter: `key = ${mdb.toMeiliValue(key)}`,
    context: { field, delta, token }
  })
  return (await getCounter(key, pubkey)).metricTokens.includes(token)
}

async function requestCapacityPruning () {
  const requestedAt = Math.floor(Date.now() / 1000)
  const result = await patchJobByKey('pruneManifestPool', { requestedAt })
  if (result.success) return
  if (result.error?.code !== 'document_not_found') throw result.error
  const created = await putJobByKey('pruneManifestPool', { startedAt: 0, endedAt: 0, requestedAt })
  if (!created.success) throw created.error
}

async function countRejection (reservation, scope) {
  const globalToken = `${reservation.key}:rejection:global`
  if (!reservation.globalRejectionCounted) {
    await incrementMetricOnce({ key: GLOBAL_KEY, field: 'rejectionCount', token: globalToken })
    reservation = await patchReservation(reservation.key, { globalRejectionCounted: true })
    await clearCounterToken(GLOBAL_KEY, 'metricTokens', globalToken)
  }
  if (scope === 'author' && !reservation.authorRejectionCounted) {
    const token = `${reservation.key}:rejection:author`
    await incrementMetricOnce({
      key: authorKey(reservation.pubkey),
      pubkey: reservation.pubkey,
      field: 'rejectionCount',
      token
    })
    await patchReservation(reservation.key, { authorRejectionCounted: true })
    await clearCounterToken(authorKey(reservation.pubkey), 'metricTokens', token)
  }
}

export async function reserveManifestCapacity ({
  pubkey, newBytes, oldBytes = 0, isReplacement = false,
  eventId = '', ref = '', oldEventId = ''
}) {
  if (!Number.isSafeInteger(newBytes) || newBytes < 0 ||
      !Number.isSafeInteger(oldBytes) || oldBytes < 0) {
    throw new TypeError('Manifest byte sizes must be non-negative safe integers')
  }
  const reservationKey = crypto.randomUUID()
  const reservedBytes = Math.max(0, newBytes - oldBytes)
  const reservedCount = isReplacement ? 0 : 1
  const now = Date.now()
  let reservation = {
    key: reservationKey,
    eventId,
    ref,
    pubkey,
    newBytes,
    observedOldEventId: oldEventId,
    observedOldBytes: oldBytes,
    reservedBytes,
    reservedCount,
    state: 'preparing',
    globalSettled: false,
    authorSettled: false,
    globalRejectionCounted: false,
    authorRejectionCounted: false,
    createdAt: now,
    updatedAt: now
  }
  await mdb.index('manifestPoolReservations').addDocuments([reservation])

  const globalAccepted = await reserveCounter({
    key: GLOBAL_KEY,
    token: reservationKey,
    deltaBytes: reservedBytes,
    deltaCount: reservedCount,
    emergency: MANIFEST_POOL_LIMITS.global.emergency
  })
  if (!globalAccepted) {
    const reason = 'global manifest pool emergency limit reached'
    reservation = await patchReservation(reservationKey, { state: 'rejected', reason, rejectionScope: 'global' })
    await countRejection(reservation, 'global')
    return { accepted: false, reservationKey, reason }
  }

  const perAuthorAccepted = await reserveCounter({
    key: authorKey(pubkey),
    pubkey,
    token: reservationKey,
    deltaBytes: reservedBytes,
    deltaCount: reservedCount,
    emergency: MANIFEST_POOL_LIMITS.author.emergency
  })
  if (!perAuthorAccepted) {
    const reason = 'author manifest pool emergency limit reached'
    reservation = await patchReservation(reservationKey, { state: 'cancel_required', reason, rejectionScope: 'author' })
    await cancelManifestReservation(reservationKey, { terminalState: 'rejected' })
    reservation = await getReservation(reservationKey)
    await countRejection(reservation, 'author')
    return { accepted: false, reservationKey, reason }
  }

  reservation = await patchReservation(reservationKey, { state: 'reserved' })

  const [global, author] = await Promise.all([
    getCounter(GLOBAL_KEY),
    getCounter(authorKey(pubkey), pubkey)
  ])
  if (global.logicalBytes > MANIFEST_POOL_LIMITS.global.nominal ||
      author.logicalBytes > MANIFEST_POOL_LIMITS.author.nominal) {
    requestCapacityPruning().catch(error => console.error('Failed to schedule manifest pool pruning', error))
  }
  return {
    accepted: true,
    reservationKey,
    reservedBytes,
    reservedCount,
    deltaBytes: newBytes - oldBytes,
    deltaCount: reservedCount
  }
}

export async function prepareManifestReservation (reservationKey, {
  actualDeltaBytes, actualDeltaCount, state = 'prepared', reason
}) {
  return patchReservation(reservationKey, {
    actualDeltaBytes,
    actualDeltaCount,
    state,
    ...(reason && { reason })
  })
}

export async function finalizeManifestReservation (reservationKey) {
  let reservation = await getReservation(reservationKey)
  if (reservation.state === 'committed') return reservation
  if (!Number.isSafeInteger(reservation.actualDeltaBytes) ||
      !Number.isSafeInteger(reservation.actualDeltaCount)) {
    throw new Error('Manifest reservation is missing its actual accounting delta')
  }
  const settlementToken = `${reservationKey}:commit`
  if (!reservation.globalSettled) {
    const settled = await settleCounterReservation({
      key: GLOBAL_KEY,
      reservationToken: reservationKey,
      settlementToken,
      reservedBytes: reservation.reservedBytes,
      reservedCount: reservation.reservedCount,
      actualDeltaBytes: reservation.actualDeltaBytes,
      actualDeltaCount: reservation.actualDeltaCount,
      outcome: 'commit'
    })
    if (!settled) throw new Error('Global manifest reservation token is missing')
    reservation = await patchReservation(reservationKey, { globalSettled: true })
  }
  if (!reservation.authorSettled) {
    const settled = await settleCounterReservation({
      key: authorKey(reservation.pubkey),
      pubkey: reservation.pubkey,
      reservationToken: reservationKey,
      settlementToken,
      reservedBytes: reservation.reservedBytes,
      reservedCount: reservation.reservedCount,
      actualDeltaBytes: reservation.actualDeltaBytes,
      actualDeltaCount: reservation.actualDeltaCount,
      outcome: 'commit'
    })
    if (!settled) throw new Error('Author manifest reservation token is missing')
    reservation = await patchReservation(reservationKey, { authorSettled: true })
  }
  reservation = await patchReservation(reservationKey, { state: 'committed' })
  await Promise.all([
    clearCounterToken(GLOBAL_KEY, 'settlementTokens', settlementToken),
    clearCounterToken(authorKey(reservation.pubkey), 'settlementTokens', settlementToken)
  ])
  return reservation
}

export async function cancelManifestReservation (reservationKey, { terminalState = 'cancelled' } = {}) {
  if (!reservationKey) return
  let reservation
  try {
    reservation = await getReservation(reservationKey)
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  if (['committed', 'cancelled', 'rejected'].includes(reservation.state)) return reservation
  const settlementToken = `${reservationKey}:cancel`
  if (!reservation.globalSettled) {
    await settleCounterReservation({
      key: GLOBAL_KEY,
      reservationToken: reservationKey,
      settlementToken,
      reservedBytes: reservation.reservedBytes,
      reservedCount: reservation.reservedCount,
      outcome: 'cancel'
    })
    reservation = await patchReservation(reservationKey, { globalSettled: true })
  }
  if (!reservation.authorSettled) {
    await settleCounterReservation({
      key: authorKey(reservation.pubkey),
      pubkey: reservation.pubkey,
      reservationToken: reservationKey,
      settlementToken,
      reservedBytes: reservation.reservedBytes,
      reservedCount: reservation.reservedCount,
      outcome: 'cancel'
    })
    reservation = await patchReservation(reservationKey, { authorSettled: true })
  }
  reservation = await patchReservation(reservationKey, { state: terminalState })
  await Promise.all([
    clearCounterToken(GLOBAL_KEY, 'settlementTokens', settlementToken),
    clearCounterToken(authorKey(reservation.pubkey), 'settlementTokens', settlementToken)
  ])
  return reservation
}

export async function rejectManifestReservation (reservationKey, reason, scope = 'global') {
  let reservation = await patchReservation(reservationKey, { state: 'cancel_required', reason, rejectionScope: scope })
  await cancelManifestReservation(reservationKey, { terminalState: 'rejected' })
  reservation = await getReservation(reservationKey)
  await countRejection(reservation, scope)
  return getReservation(reservationKey)
}

async function applyCounterAccountingOnce ({
  key, pubkey, token, deltaBytes, deltaCount, pruningCount = 0
}) {
  await getCounter(key, pubkey)
  await mdb.index('manifestPoolUsage').updateDocumentsByFunction({
    function: `
      let seen = false;
      for existing in doc.accountingTokens {
        if existing == context.token { seen = true; }
      }
      if !seen {
        let next_bytes = doc.logicalBytes + context.deltaBytes;
        let next_count = doc.manifestCount + context.deltaCount;
        if next_bytes < 0 { next_bytes = 0; }
        if next_count < 0 { next_count = 0; }
        doc.logicalBytes = next_bytes;
        doc.manifestCount = next_count;
        doc.pruningCount = doc.pruningCount + context.pruningCount;
        doc.accountingTokens.push(context.token);
        doc.mutationVersion = doc.mutationVersion + 1;
      }
      doc
    `,
    filter: `key = ${mdb.toMeiliValue(key)}`,
    context: { token, deltaBytes, deltaCount, pruningCount }
  })
}

export async function applyManifestDeletionAccounting (events, {
  operationKey, pruning = false
}) {
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
  await applyCounterAccountingOnce({
    key: GLOBAL_KEY,
    token: `${operationKey}:${GLOBAL_KEY}`,
    deltaBytes: -logicalBytes,
    deltaCount: -events.length,
    pruningCount: pruning ? events.length : 0
  })
  for (const [pubkey, usage] of byAuthor) {
    const key = authorKey(pubkey)
    await applyCounterAccountingOnce({
      key,
      pubkey,
      token: `${operationKey}:${key}`,
      deltaBytes: -usage.logicalBytes,
      deltaCount: -usage.count,
      pruningCount: pruning ? usage.count : 0
    })
  }
}

export async function clearManifestDeletionAccountingTokens (events, operationKey) {
  if (!events.length) return
  const pubkeys = new Set(events.map(event => event.pubkey))
  await clearCounterToken(GLOBAL_KEY, 'accountingTokens', `${operationKey}:${GLOBAL_KEY}`)
  await Promise.all([...pubkeys].map(pubkey => {
    const key = authorKey(pubkey)
    return clearCounterToken(key, 'accountingTokens', `${operationKey}:${key}`)
  }))
}

export async function recoverManifestReservations ({
  orphanGraceMs = ORPHAN_RESERVATION_GRACE_MS
} = {}) {
  const terminalStates = new Set(['committed', 'cancelled', 'rejected'])
  const terminalBefore = Date.now() - TERMINAL_RESERVATION_RETENTION_MS
  let offset = 0
  let recovered = 0
  while (true) {
    const { results } = await mdb.index('manifestPoolReservations').getDocuments({
      limit: 100,
      offset,
      sort: ['createdAt:asc']
    })
    if (!results.length) break
    const terminalToDelete = []
    for (const reservation of results) {
      if (terminalStates.has(reservation.state)) {
        if (reservation.state === 'rejected' &&
            (!reservation.globalRejectionCounted ||
             (reservation.rejectionScope === 'author' && !reservation.authorRejectionCounted))) {
          await countRejection(reservation, reservation.rejectionScope || 'global')
        }
        const outcome = reservation.state === 'committed' ? 'commit' : 'cancel'
        const settlementToken = `${reservation.key}:${outcome}`
        await Promise.all([
          clearCounterToken(GLOBAL_KEY, 'settlementTokens', settlementToken),
          clearCounterToken(authorKey(reservation.pubkey), 'settlementTokens', settlementToken)
        ])
        if (reservation.state === 'rejected') {
          await Promise.all([
            clearCounterToken(GLOBAL_KEY, 'metricTokens', `${reservation.key}:rejection:global`),
            clearCounterToken(authorKey(reservation.pubkey), 'metricTokens', `${reservation.key}:rejection:author`)
          ])
        }
        if ((reservation.updatedAt || reservation.createdAt || 0) <= terminalBefore) {
          terminalToDelete.push(reservation.key)
        }
        continue
      }
      if (reservation.state === 'cancel_required') {
        const terminalState = reservation.rejectionScope ? 'rejected' : 'cancelled'
        await cancelManifestReservation(reservation.key, { terminalState })
        if (terminalState === 'rejected') {
          await countRejection(await getReservation(reservation.key), reservation.rejectionScope)
        }
        recovered++
        continue
      }

      let current = null
      if (reservation.ref) {
        try { current = await mdb.index('events').getDocument(reservation.ref) } catch (error) {
          if (!isNotFound(error)) throw error
        }
      }
      if (['prepared', 'event_applied'].includes(reservation.state) &&
          current?.id === reservation.eventId) {
        await finalizeManifestReservation(reservation.key)
        recovered++
        continue
      }

      const { hits: pending } = await mdb.index('pendingOps').search('', {
        filter: `reservationKey = ${mdb.toMeiliValue(reservation.key)}`,
        limit: 1
      })
      if (pending.length) continue

      // A saver reserves first and enqueues its workflow immediately after.
      // Give that cross-index handoff a short lease so the periodic recovery
      // cannot mistake an in-flight producer for an orphan.
      if (Date.now() - (reservation.updatedAt || reservation.createdAt || 0) < orphanGraceMs) continue

      await cancelManifestReservation(reservation.key)
      recovered++
    }
    if (terminalToDelete.length) {
      await mdb.index('manifestPoolReservations').deleteDocuments(terminalToDelete)
    }
    if (results.length < 100) break
    offset += results.length - terminalToDelete.length
  }
  return recovered
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
    const normalized = await Promise.all(results.map(counter => {
      const complete = COUNTER_NUMBER_FIELDS.every(field => Number.isFinite(counter[field])) &&
        COUNTER_ARRAY_FIELDS.every(field => Array.isArray(counter[field]))
      return complete ? counter : getCounter(counter.key, counter.pubkey)
    }))
    authors.push(...normalized)
    if (results.length < 500) break
    offset += results.length
  }
  return { global, authors }
}

function counterHasActiveMutation (counter) {
  return ['reservationTokens', 'settlementTokens', 'workflowTokens']
    .some(field => counter[field]?.length)
}

async function applyReconciledCounter ({
  key, pubkey, expectedVersion, logicalBytes, manifestCount, reconciledAt,
  reconciliationToken, usedDatabaseSize
}) {
  await mdb.index('manifestPoolUsage').updateDocumentsByFunction({
    function: `
      let can_reconcile = doc.mutationVersion == context.expectedVersion;
      for _token in doc.reservationTokens { can_reconcile = false; }
      for _token in doc.settlementTokens { can_reconcile = false; }
      for _token in doc.workflowTokens { can_reconcile = false; }
      if can_reconcile {
        doc.logicalBytes = context.logicalBytes;
        doc.manifestCount = context.manifestCount;
        doc.reconciledAt = context.reconciledAt;
        doc.lastReconciliationToken = context.reconciliationToken;
        doc.accountingTokens = [];
        doc.settlementTokens = [];
        doc.mutationVersion = doc.mutationVersion + 1;
        if context.usedDatabaseSize != () {
          doc.usedDatabaseSize = context.usedDatabaseSize;
        }
      }
      doc
    `,
    filter: `key = ${mdb.toMeiliValue(key)}`,
    context: {
      expectedVersion,
      logicalBytes,
      manifestCount,
      reconciledAt,
      reconciliationToken,
      usedDatabaseSize
    }
  })
  const counter = await getCounter(key, pubkey)
  return counter.lastReconciliationToken === reconciliationToken
}

// Rebuilds logical counters from the events index, which is the source of
// truth after crashes and partial queue processing. A monotonic version makes
// the final writes conditional: live reservations/deletions invalidate this
// snapshot instead of being overwritten by a non-transactional scan.
export async function reconcileManifestPoolUsage () {
  await recoverManifestReservations()
  const previousUsage = await getManifestPoolUsage()
  if (counterHasActiveMutation(previousUsage.global)) {
    console.log('Manifest pool reconciliation deferred while accounting is active')
    return previousUsage
  }

  const previousAuthors = new Map(previousUsage.authors.map(counter => [counter.pubkey, counter]))
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
  let usedDatabaseSize
  try {
    const stats = await mdb.getStats()
    usedDatabaseSize = stats.usedDatabaseSize ?? stats.databaseSize
  } catch (_) {}

  const reconciliationToken = crypto.randomUUID()
  const globalApplied = await applyReconciledCounter({
    key: GLOBAL_KEY,
    expectedVersion: previousUsage.global.mutationVersion,
    logicalBytes: globalBytes,
    manifestCount: globalCount,
    reconciledAt: now,
    reconciliationToken,
    usedDatabaseSize
  })
  if (!globalApplied) {
    console.log('Manifest pool reconciliation invalidated by concurrent accounting')
    return getManifestPoolUsage()
  }

  const allPubkeys = new Set([...previousAuthors.keys(), ...byAuthor.keys()])
  for (const pubkey of allPubkeys) {
    const usage = byAuthor.get(pubkey) || { bytes: 0, count: 0 }
    let previous = previousAuthors.get(pubkey)
    if (!previous) previous = await getCounter(authorKey(pubkey), pubkey)
    await applyReconciledCounter({
      key: authorKey(pubkey),
      pubkey,
      expectedVersion: previous.mutationVersion,
      logicalBytes: usage.bytes,
      manifestCount: usage.count,
      reconciledAt: now,
      reconciliationToken
    })
  }

  const usage = await getManifestPoolUsage()
  console.log('Manifest pool usage', {
    logicalBytes: usage.global.logicalBytes,
    manifestCount: usage.global.manifestCount,
    usedDatabaseSize: usage.global.usedDatabaseSize ?? null
  })
  return usage
}

export { authorKey, GLOBAL_KEY }
