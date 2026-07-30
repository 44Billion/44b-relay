import crypto from 'node:crypto'
import mdb from '#services/db/mdb.js'
import { eventKinds, RELAY_OWNED_KINDS } from '#constants/event.js'
import { checkpoint } from '#helpers/abort.js'
import {
  isValidPrimaryKey,
  primaryKeyToIp
} from '#helpers/mdb.js'
import {
  getPopularityLevel,
  getStorageLimit,
  loadPopularityFilters,
  queueOps,
  VIP_PUBKEYS
} from '#services/event/maintainer/mdb/index.js'
import {
  applyStoredUsageDeltasOnce,
  clearStoredUsageDeltaTokens
} from '#services/event/stored-owner-accounting.js'

export const PRUNE_WORKFLOW_VERSION = 1
export const PRUNE_BATCH_SIZE = 100

const ORDINARY_KIND_FILTER = [...RELAY_OWNED_KINDS]
  .map(kind => `kind != ${kind}`)
  .join(' AND ')

function isNotFound (error) {
  return error?.code === 'document_not_found' ||
    error?.cause?.code === 'document_not_found'
}

async function getOwner (ownerKey) {
  try {
    return await mdb.index('storedEventOwners').getDocument(ownerKey)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

async function getEvent (ref) {
  try {
    return await mdb.index('events').getDocument(ref)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

async function patchPendingOp (op, phase, data = op.data, extra = {}) {
  const startedAt = op.startedAt || Date.now()
  await mdb.index('pendingOps').updateDocuments([{
    key: op.key,
    phase,
    startedAt,
    data,
    ...extra
  }])
  Object.assign(op, { phase, startedAt, data }, extra)
}

async function deletePendingOp (key) {
  await mdb.index('pendingOps').deleteDocument(key)
}

function ownerFilter ({ ownerKey, ownerType }) {
  return ownerType === 'pubkey'
    ? `pubkey = ${mdb.toMeiliValue(ownerKey)} AND ownerType = "pubkey" AND ${ORDINARY_KIND_FILTER}`
    : `ip = ${mdb.toMeiliValue(primaryKeyToIp(ownerKey))} AND ownerType = "ip" AND ${ORDINARY_KIND_FILTER}`
}

function workflowBaseData (data) {
  const {
    actions: _actions,
    applied: _applied,
    deltas: _deltas,
    effectKey: _effectKey,
    ...base
  } = data || {}
  return base
}

function isStillStale (owner, data) {
  if (!Number.isFinite(data?.staleIfLastActiveAtLte)) return true
  return (owner?.lastActiveAt || 0) <= data.staleIfLastActiveAtLte
}

function actionSnapshot (event, {
  action,
  ownerKey,
  ownerType,
  popularityLevel
}) {
  return {
    ref: event.ref,
    id: event.id,
    kind: event.kind,
    pubkey: event.pubkey,
    byteSize: event.byteSize || 0,
    ownerKey,
    ownerType,
    action,
    ...(action === 'promote'
      ? {
          destinationOwnerKey: event.pubkey,
          destinationPopularityLevel: popularityLevel
        }
      : {})
  }
}

async function selectActions ({ ownerKey, ownerType, signal }) {
  checkpoint(signal)
  if (ownerType === 'ip') await loadPopularityFilters()
  const filter = ownerFilter({ ownerKey, ownerType })
  const commonOptions = {
    sort: ['created_at:asc'],
    limit: PRUNE_BATCH_SIZE,
    attributesToRetrieve: [
      'ref',
      'id',
      'kind',
      'pubkey',
      'byteSize',
      'ownerType',
      'ip',
      'created_at'
    ]
  }

  // Chunks are always discarded before ordinary events, including for an IP
  // whose author has since become popular.
  const chunks = await mdb.index('events').search('', {
    ...commonOptions,
    filter: `${filter} AND kind = ${eventKinds.BINARY_DATA_CHUNK}`
  })
  if (chunks.hits.length) {
    return chunks.hits.map(event => actionSnapshot(event, {
      action: 'delete',
      ownerKey,
      ownerType
    }))
  }

  checkpoint(signal)
  const ordinary = await mdb.index('events').search('', {
    ...commonOptions,
    filter
  })
  if (ownerType === 'pubkey') {
    return ordinary.hits.map(event => actionSnapshot(event, {
      action: 'delete',
      ownerKey,
      ownerType
    }))
  }

  return ordinary.hits.map(event => {
    const popularityLevel = getPopularityLevel(event.pubkey)
    const action = popularityLevel <= 5 ? 'promote' : 'delete'
    return actionSnapshot(event, {
      action,
      ownerKey,
      ownerType,
      popularityLevel
    })
  })
}

async function applyActions (actions, { signal } = {}) {
  const deletions = actions.filter(action => action.action === 'delete')
  if (deletions.length) {
    checkpoint(signal)
    const filter = deletions
      .map(event => (
        `(ref = ${mdb.toMeiliValue(event.ref)} AND ` +
        `id = ${mdb.toMeiliValue(event.id)})`
      ))
      .join(' OR ')
    await mdb.index('events').deleteDocuments({ filter })
  }

  const promotions = []
  for (const action of actions.filter(action => action.action === 'promote')) {
    checkpoint(signal)
    const current = await getEvent(action.ref)
    if (current?.id === action.id && current.ownerType === 'ip') {
      promotions.push({
        ref: action.ref,
        ownerType: 'pubkey',
        popularityLevel: action.destinationPopularityLevel
      })
    }
  }
  if (promotions.length) {
    checkpoint(signal)
    await mdb.index('events').updateDocuments(promotions)
  }

  const applied = []
  for (const action of actions) {
    checkpoint(signal)
    const current = await getEvent(action.ref)
    if (action.action === 'delete') {
      if (current?.id === action.id) {
        throw new Error(`Prune deletion was not applied for ${action.ref}`)
      }
      applied.push(action)
      continue
    }

    if (current?.id !== action.id) {
      // The selected version disappeared after its intent was persisted. Its
      // old owner still needs the same subtraction, but no destination credit.
      applied.push({ ...action, action: 'delete' })
      continue
    }
    if (current.ownerType !== 'pubkey') {
      throw new Error(`Prune promotion was not applied for ${action.ref}`)
    }
    applied.push(action)
  }
  return applied
}

function usageDeltas (applied) {
  const deltas = []
  for (const action of applied) {
    const bytes = action.byteSize || 0
    if (!bytes) continue
    deltas.push({
      ownerKey: action.ownerKey,
      ownerType: action.ownerType,
      delta: -bytes
    })
    if (action.action === 'promote') {
      deltas.push({
        ownerKey: action.destinationOwnerKey,
        ownerType: 'pubkey',
        popularityLevel: action.destinationPopularityLevel,
        delta: bytes
      })
    }
  }
  return deltas
}

function deterministicPruneKey (scope, ownerKey) {
  return `prune_${crypto
    .createHash('sha256')
    .update(`${scope}\0${ownerKey}`)
    .digest('hex')}`
}

export async function queuePruneCheckOnce ({
  ownerKey,
  ownerType,
  limit,
  popularityLevel,
  deleteOwnerWhenEmpty = false,
  staleIfLastActiveAtLte,
  source,
  dedupeScope = source || 'owner-limit',
  signal
}) {
  checkpoint(signal)
  const key = deterministicPruneKey(dedupeScope, ownerKey)
  try {
    await mdb.index('pendingOps').getDocument(key)
    return { key, queued: false }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }

  await queueOps([{
    key,
    type: 'pruneCheck',
    source,
    data: {
      key: ownerKey,
      entityType: ownerType,
      limit,
      popularityLevel,
      workflowVersion: PRUNE_WORKFLOW_VERSION,
      step: 0,
      deleteOwnerWhenEmpty,
      ...(Number.isFinite(staleIfLastActiveAtLte)
        ? { staleIfLastActiveAtLte }
        : {})
    }
  }])
  return { key, queued: true }
}

async function queueDestinationChecks (applied, effectKey, { signal } = {}) {
  const destinations = new Map()
  for (const action of applied) {
    if (action.action !== 'promote') continue
    destinations.set(action.destinationOwnerKey, {
      ownerKey: action.destinationOwnerKey,
      popularityLevel: action.destinationPopularityLevel
    })
  }

  for (const destination of destinations.values()) {
    checkpoint(signal)
    if (VIP_PUBKEYS.has(destination.ownerKey)) continue
    const limit = getStorageLimit(destination.popularityLevel)
    await queuePruneCheckOnce({
      ownerKey: destination.ownerKey,
      ownerType: 'pubkey',
      limit,
      popularityLevel: destination.popularityLevel,
      source: 'prunePromotion',
      dedupeScope: `${effectKey}:destination`,
      signal
    })
  }
}

async function sumActualOwnerBytes ({ ownerKey, ownerType, signal }) {
  const filter = ownerFilter({ ownerKey, ownerType })
  let total = 0
  let offset = 0
  while (true) {
    checkpoint(signal)
    const { results } = await mdb.index('events').getDocuments({
      filter,
      fields: ['ref', 'byteSize'],
      sort: ['created_at:asc'],
      limit: PRUNE_BATCH_SIZE,
      offset
    })
    for (const event of results) total += event.byteSize || 0
    if (results.length < PRUNE_BATCH_SIZE) return total
    offset += results.length
  }
}

async function maybeDeleteEmptyOwner (ownerKey, data, { signal } = {}) {
  if (!data.deleteOwnerWhenEmpty) return
  checkpoint(signal)
  const owner = await getOwner(ownerKey)
  if (!owner || !isStillStale(owner, data) || (owner.usedBytes || 0) > 0) return
  const actualBytes = await sumActualOwnerBytes({
    ownerKey,
    ownerType: data.entityType,
    signal
  })
  if (actualBytes === 0) {
    checkpoint(signal)
    // The IP may publish again between the read above and this task reaching
    // Meilisearch. Delete through a document function so activity and usage
    // are checked atomically when the mutation is applied.
    await mdb.index('storedEventOwners').updateDocumentsByFunction({
      function: `
        if doc.entityType == context.ownerType &&
           doc.usedBytes <= 0 &&
           doc.lastActiveAt <= context.staleIfLastActiveAtLte {
          doc = ();
        }
        doc
      `,
      filter: `key = ${mdb.toMeiliValue(ownerKey)}`,
      context: {
        ownerType: data.entityType,
        staleIfLastActiveAtLte: data.staleIfLastActiveAtLte
      }
    })
  }
}

async function cancelPreparedStalePruneIfReactivated (
  op,
  data,
  { signal } = {}
) {
  if (!Number.isFinite(data.staleIfLastActiveAtLte)) return false
  checkpoint(signal)
  const owner = await getOwner(data.key)
  if (!owner || isStillStale(owner, data)) return false

  // No destructive action has run in `prepared`, so renewed activity can
  // safely cancel the persisted intent. Later phases must instead finish
  // their accounting because their event mutations may already have landed.
  await deletePendingOp(op.key)
  return true
}

async function finishOrContinue (op, data, { signal } = {}) {
  checkpoint(signal)
  const owner = await getOwner(data.key)
  if (!owner) {
    await deletePendingOp(op.key)
    return
  }
  if (!isStillStale(owner, data)) {
    await deletePendingOp(op.key)
    return
  }

  const limit = Number.isFinite(data.limit) ? Math.max(0, data.limit) : 0
  if ((owner.usedBytes || 0) > limit) {
    const base = workflowBaseData(data)
    await patchPendingOp(op, 'queued', {
      ...base,
      workflowVersion: PRUNE_WORKFLOW_VERSION,
      step: (data.step || 0) + 1
    })
    return
  }

  await maybeDeleteEmptyOwner(data.key, data, { signal })
  checkpoint(signal)
  await deletePendingOp(op.key)
}

async function handleNoActions (op, data, owner, { signal } = {}) {
  if ((data.workflowVersion || 0) < PRUNE_WORKFLOW_VERSION &&
      !data.legacyDeferred) {
    // Legacy event-save batches placed pruneCheck before the event write.
    // Moving this same operation to the tail gives those writes a chance to
    // land without losing the already-applied usage delta.
    await patchPendingOp(op, 'queued', {
      ...workflowBaseData(data),
      workflowVersion: PRUNE_WORKFLOW_VERSION,
      legacyDeferred: true,
      step: data.step || 0
    }, {
      createdAt: Date.now(),
      batchId: crypto.randomUUID(),
      position: 0
    })
    return
  }

  const actualBytes = await sumActualOwnerBytes({
    ownerKey: data.key,
    ownerType: data.entityType,
    signal
  })
  checkpoint(signal)
  if ((owner.usedBytes || 0) !== actualBytes) {
    await mdb.index('storedEventOwners').updateDocuments([{
      key: data.key,
      usedBytes: actualBytes
    }])
  }
  await maybeDeleteEmptyOwner(data.key, data, { signal })
  await deletePendingOp(op.key)
}

export async function processPruneCheck (op, { signal } = {}) {
  checkpoint(signal)
  const data = op.data || {}
  if (!isValidPrimaryKey(data.key) ||
      !['ip', 'pubkey'].includes(data.entityType) ||
      !Number.isFinite(data.limit) ||
      data.limit < 0) {
    throw new TypeError('Invalid pruneCheck operation')
  }

  if ((op.phase || 'queued') === 'queued') {
    const owner = await getOwner(data.key)
    if (!owner || !isStillStale(owner, data)) {
      await deletePendingOp(op.key)
      return
    }
    if (data.entityType === 'pubkey' && VIP_PUBKEYS.has(data.key)) {
      await deletePendingOp(op.key)
      return
    }
    if ((owner.usedBytes || 0) <= data.limit) {
      await maybeDeleteEmptyOwner(data.key, data, { signal })
      await deletePendingOp(op.key)
      return
    }

    const actions = await selectActions({
      ownerKey: data.key,
      ownerType: data.entityType,
      signal
    })
    if (!actions.length) {
      await handleNoActions(op, data, owner, { signal })
      return
    }

    const step = Number.isSafeInteger(data.step) ? data.step : 0
    await patchPendingOp(op, 'prepared', {
      ...workflowBaseData(data),
      workflowVersion: PRUNE_WORKFLOW_VERSION,
      step,
      effectKey: `${op.key}:${step}`,
      actions
    })
  }

  if (op.phase === 'prepared') {
    if (await cancelPreparedStalePruneIfReactivated(op, op.data, { signal })) {
      return
    }
    checkpoint(signal)
    const applied = await applyActions(op.data.actions || [], { signal })
    await patchPendingOp(op, 'events_applied', {
      ...op.data,
      applied
    })
  }

  if (op.phase === 'events_applied') {
    const deltas = usageDeltas(op.data.applied || [])
    checkpoint(signal)
    await applyStoredUsageDeltasOnce(deltas, op.data.effectKey, { signal })
    await patchPendingOp(op, 'accounting_applied', {
      ...op.data,
      deltas
    })
  }

  if (op.phase === 'accounting_applied') {
    checkpoint(signal)
    await queueDestinationChecks(
      op.data.applied || [],
      op.data.effectKey,
      { signal }
    )
    await clearStoredUsageDeltaTokens(
      op.data.deltas || [],
      op.data.effectKey,
      { signal }
    )
    await finishOrContinue(op, op.data, { signal })
  }
}
