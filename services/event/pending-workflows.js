import mdb from '#services/db/mdb.js'
import { queueOps } from '#services/event/maintainer/mdb/index.js'
import {
  applyManifestDeletionAccounting,
  beginManifestMutation,
  cancelManifestReservation,
  clearManifestDeletionAccountingTokens,
  finalizeManifestReservation,
  finishManifestMutation,
  isManifestKind,
  prepareManifestReservation,
  rejectManifestReservation
} from '#services/event/manifest-pool.js'
import { RELAY_OWNED_KINDS } from '#constants/event.js'
import { ipToPrimaryKey } from '#helpers/mdb.js'

export const PENDING_WORKFLOW_TYPES = new Set([
  'upsertManifestWithReservation',
  'deleteEventsWithAccounting'
])

export function isPendingWorkflow (op) {
  return PENDING_WORKFLOW_TYPES.has(op?.type)
}

function isNotFound (error) {
  return error?.code === 'document_not_found' || error?.cause?.code === 'document_not_found'
}

export function isNetworkError (error) {
  return error?.name === 'MeiliSearchCommunicationError' ||
    ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(error?.code) ||
    ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(error?.cause?.code)
}

async function getEvent (ref) {
  try {
    return await mdb.index('events').getDocument(ref)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

async function patchPendingOp (op, phase, data = op.data) {
  const startedAt = op.startedAt || Date.now()
  await mdb.index('pendingOps').updateDocuments([{
    key: op.key,
    phase,
    startedAt,
    data
  }])
  op.phase = phase
  op.startedAt = startedAt
  op.data = data
}

async function deletePendingOp (key) {
  await mdb.index('pendingOps').deleteDocument(key)
}

function currentWins (current, candidate) {
  return current && (
    current.created_at > candidate.created_at ||
    (current.created_at === candidate.created_at && current.id < candidate.id)
  )
}

async function markCancellationAndCancel (reservationKey, reason) {
  await prepareManifestReservation(reservationKey, {
    actualDeltaBytes: 0,
    actualDeltaCount: 0,
    state: 'cancel_required',
    reason
  })
  await cancelManifestReservation(reservationKey)
}

async function recordManifestUpsertFailure (op, reservationKey, error) {
  let reservation
  try {
    reservation = await mdb.index('manifestPoolReservations').getDocument(reservationKey)
  } catch (reservationError) {
    if (isNotFound(reservationError)) return
    throw reservationError
  }
  if (['committed', 'cancelled', 'rejected'].includes(reservation.state)) return

  const document = op.data?.document
  const current = document?.ref ? await getEvent(document.ref) : null
  if (current?.id === document?.id &&
      Number.isSafeInteger(reservation.actualDeltaBytes) &&
      Number.isSafeInteger(reservation.actualDeltaCount)) {
    await prepareManifestReservation(reservationKey, {
      actualDeltaBytes: reservation.actualDeltaBytes,
      actualDeltaCount: reservation.actualDeltaCount,
      state: 'event_applied',
      reason: error.message || 'manifest upsert requires recovery'
    })
    try {
      await finalizeManifestReservation(reservationKey)
    } catch (finalizationError) {
      // The durable event_applied state is enough for the reservation recovery
      // job to retry accounting after this malformed operation is consumed.
      console.error(`Failed to finish manifest reservation ${reservationKey}`, finalizationError)
    }
    return
  }

  // Persisting cancel_required is the compensation record. Once it exists the
  // operation can be consumed even if immediate cancellation itself fails;
  // the reservation recovery job will retry it.
  await prepareManifestReservation(reservationKey, {
    actualDeltaBytes: 0,
    actualDeltaCount: 0,
    state: 'cancel_required',
    reason: error.message || 'manifest upsert failed'
  })
  try {
    await cancelManifestReservation(reservationKey)
  } catch (cancellationError) {
    console.error(`Failed to cancel manifest reservation ${reservationKey}`, cancellationError)
  }
}

async function processManifestUpsert (op) {
  const { document, reservationKey } = op.data || {}
  if (!document?.ref || !document?.id || !reservationKey) {
    throw new TypeError('Invalid upsertManifestWithReservation operation')
  }

  const initialReservation = await mdb.index('manifestPoolReservations').getDocument(reservationKey)
  if (['committed', 'cancelled', 'rejected'].includes(initialReservation.state)) {
    await deletePendingOp(op.key)
    return
  }
  if (initialReservation.state === 'cancel_required') {
    await cancelManifestReservation(reservationKey)
    await deletePendingOp(op.key)
    return
  }

  if ((op.phase || 'queued') === 'queued') {
    const current = await getEvent(document.ref)
    if (current?.id === document.id) {
      await markCancellationAndCancel(reservationKey, 'manifest is already stored')
      await deletePendingOp(op.key)
      return
    }
    if (currentWins(current, document)) {
      await markCancellationAndCancel(reservationKey, 'a newer manifest is already stored')
      await deletePendingOp(op.key)
      return
    }

    const reservation = await mdb.index('manifestPoolReservations').getDocument(reservationKey)
    const actualDeltaBytes = (document.byteSize || 0) - (current?.byteSize || 0)
    const actualDeltaCount = current ? 0 : 1
    if (actualDeltaBytes > (reservation.reservedBytes || 0) ||
        actualDeltaCount > (reservation.reservedCount || 0)) {
      await rejectManifestReservation(reservationKey, 'manifest capacity changed before persistence')
      await deletePendingOp(op.key)
      return
    }
    await prepareManifestReservation(reservationKey, { actualDeltaBytes, actualDeltaCount })
    await patchPendingOp(op, 'prepared')
  }

  if (op.phase === 'prepared') {
    const current = await getEvent(document.ref)
    if (current?.id !== document.id) {
      if (currentWins(current, document)) {
        await markCancellationAndCancel(reservationKey, 'a newer manifest was stored before persistence')
        await deletePendingOp(op.key)
        return
      }
      await mdb.index('events').addDocuments([document])
    }
    const reservation = await mdb.index('manifestPoolReservations').getDocument(reservationKey)
    await prepareManifestReservation(reservationKey, {
      actualDeltaBytes: reservation.actualDeltaBytes,
      actualDeltaCount: reservation.actualDeltaCount,
      state: 'event_applied'
    })
    await patchPendingOp(op, 'event_applied')
  }

  if (op.phase === 'event_applied') {
    await finalizeManifestReservation(reservationKey)
    await patchPendingOp(op, 'accounting_applied')
  }

  if (op.phase === 'accounting_applied') await deletePendingOp(op.key)
}

function deletionSnapshot (event) {
  const ownerType = event.ownerType === 'ip' ? 'ip' : 'pubkey'
  const ownerKey = ownerType === 'ip' ? ipToPrimaryKey(event.ip) : event.pubkey
  return {
    ref: event.ref,
    id: event.id,
    kind: event.kind,
    pubkey: event.pubkey,
    byteSize: event.byteSize || 0,
    ownerType,
    ...(ownerKey && { ownerKey })
  }
}

export async function queueDeleteEventsWithAccounting (events, { pruning = false, source } = {}) {
  for (let start = 0; start < events.length; start += 100) {
    const snapshots = events.slice(start, start + 100).map(deletionSnapshot)
    await queueOps([{
      type: 'deleteEventsWithAccounting',
      data: { events: snapshots, pruning },
      ...(source && { source })
    }])
  }
}

async function ensureStoredOwnerTokens (owner) {
  let doc
  try {
    doc = await mdb.index('storedEventOwners').getDocument(owner.ownerKey)
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
  if (!Array.isArray(doc.accountingTokens)) {
    // Initialize only if the field is still missing. A normal partial patch
    // with [] could erase a token concurrently written by another workflow.
    await mdb.index('storedEventOwners').updateDocumentsByFunction({
      function: `
        if doc.accountingTokens == () { doc.accountingTokens = []; }
        doc
      `,
      filter: `key = ${mdb.toMeiliValue(owner.ownerKey)}`
    })
  }
  return true
}

async function applyStoredDeletionAccounting (events, operationKey) {
  const owners = new Map()
  for (const event of events) {
    if (!event.ownerKey || RELAY_OWNED_KINDS.has(event.kind)) continue
    const current = owners.get(event.ownerKey) || {
      ownerKey: event.ownerKey,
      ownerType: event.ownerType,
      bytes: 0
    }
    current.bytes += event.byteSize || 0
    owners.set(event.ownerKey, current)
  }
  for (const owner of owners.values()) {
    if (!await ensureStoredOwnerTokens(owner)) continue
    const token = `${operationKey}:${owner.ownerKey}`
    await mdb.index('storedEventOwners').updateDocumentsByFunction({
      function: `
        let seen = false;
        for existing in doc.accountingTokens {
          if existing == context.token { seen = true; }
        }
        if !seen {
          let next_bytes = doc.usedBytes - context.bytes;
          if next_bytes < 0 { next_bytes = 0; }
          doc.usedBytes = next_bytes;
          doc.accountingTokens.push(context.token);
        }
        doc
      `,
      filter: `key = ${mdb.toMeiliValue(owner.ownerKey)}`,
      context: { token, bytes: owner.bytes }
    })
  }
}

async function clearStoredDeletionAccountingTokens (events, operationKey) {
  const ownerKeys = new Set(events
    .filter(event => event.ownerKey && !RELAY_OWNED_KINDS.has(event.kind))
    .map(event => event.ownerKey))
  for (const ownerKey of ownerKeys) {
    const token = `${operationKey}:${ownerKey}`
    await mdb.index('storedEventOwners').updateDocumentsByFunction({
      function: `
        let remaining = [];
        for existing in doc.accountingTokens {
          if existing != context.token { remaining.push(existing); }
        }
        doc.accountingTokens = remaining;
        doc
      `,
      filter: `key = ${mdb.toMeiliValue(ownerKey)}`,
      context: { token }
    })
  }
}

async function processDeletion (op) {
  const requested = op.data?.events
  if (!Array.isArray(requested) || requested.length > 100) {
    throw new TypeError('Invalid deleteEventsWithAccounting operation')
  }

  if ((op.phase || 'queued') === 'queued') {
    const selected = []
    for (const snapshot of requested) {
      if (!snapshot?.ref || !snapshot?.id) continue
      const current = await getEvent(snapshot.ref)
      if (current?.id === snapshot.id) selected.push(snapshot)
    }
    await patchPendingOp(op, 'prepared', {
      ...op.data,
      selected,
      effectKey: op.data.effectKey || op.key,
      compensationAttempts: op.data.compensationAttempts || 0
    })
  }

  const selected = op.data.selected || []
  const effectKey = op.data.effectKey || op.key
  const manifests = selected.filter(event => isManifestKind(event.kind))
  if (op.phase === 'prepared') {
    if (manifests.length) await beginManifestMutation(effectKey)
    if (selected.length) {
      const filter = selected
        .map(event => `(ref = ${mdb.toMeiliValue(event.ref)} AND id = ${mdb.toMeiliValue(event.id)})`)
        .join(' OR ')
      await mdb.index('events').deleteDocuments({ filter })
    }
    await patchPendingOp(op, 'events_deleted')
  }

  if (op.phase === 'events_deleted') {
    if (manifests.length) await beginManifestMutation(effectKey)
    await applyStoredDeletionAccounting(selected, effectKey)
    await applyManifestDeletionAccounting(manifests, {
      operationKey: effectKey,
      pruning: Boolean(op.data.pruning)
    })
    await patchPendingOp(op, 'accounting_applied')
  }

  if (op.phase === 'accounting_applied') {
    await clearStoredDeletionAccountingTokens(selected, effectKey)
    await clearManifestDeletionAccountingTokens(manifests, effectKey)
    if (manifests.length) await finishManifestMutation(effectKey)
    await deletePendingOp(op.key)
  }
}

async function selectDeletedSnapshots (events) {
  const deleted = []
  for (const event of events) {
    const current = await getEvent(event.ref)
    if (current?.id !== event.id) deleted.push(event)
  }
  return deleted
}

async function queueDeletionCompensation (op) {
  let latest = op
  try { latest = await mdb.index('pendingOps').getDocument(op.key) } catch (_) {}
  const attempts = latest.data?.compensationAttempts || 0
  if (attempts >= 1) return false

  let phase = latest.phase
  let selected = latest.data?.selected || []
  if (phase === 'prepared') {
    selected = await selectDeletedSnapshots(selected)
    if (!selected.length) return false
    phase = 'events_deleted'
  }
  if (!['events_deleted', 'accounting_applied'].includes(phase)) return false

  await queueOps([{
    type: 'deleteEventsWithAccounting',
    phase,
    source: 'pendingWorkflowCompensation',
    data: {
      ...latest.data,
      selected,
      effectKey: latest.data.effectKey || op.key,
      compensationAttempts: attempts + 1
    }
  }])
  return true
}

export async function processPendingWorkflow (op) {
  try {
    if (op.type === 'upsertManifestWithReservation') return await processManifestUpsert(op)
    if (op.type === 'deleteEventsWithAccounting') return await processDeletion(op)
    throw new TypeError(`Unknown pending workflow type: ${op.type}`)
  } catch (error) {
    if (isNetworkError(error)) throw error
    console.error(`Permanent workflow error ${op.key} (${op.type})`, error)
    const reservationKey = op.reservationKey || op.data?.reservationKey
    if (op.type === 'upsertManifestWithReservation' && reservationKey) {
      // Do not consume the bad upsert until its compensation state has been
      // durably recorded. A failure here, transient or otherwise, keeps it.
      await recordManifestUpsertFailure(op, reservationKey, error)
    }
    if (op.type === 'deleteEventsWithAccounting') {
      const queued = await queueDeletionCompensation(op)
      if (!queued) {
        const effectKey = op.data?.effectKey || op.key
        const selected = op.data?.selected || []
        if (selected.some(event => isManifestKind(event.kind))) {
          await finishManifestMutation(effectKey)
        }
      }
    }
    // Preserve the queue's existing policy: malformed/non-transient operations
    // are consumed so one bad item cannot block all later work.
    await deletePendingOp(op.key)
  }
}
