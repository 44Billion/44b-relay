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
import {
  getPruneTargetBytes,
  PRUNE_WORKFLOW_VERSION
} from '#services/event/prune-policy.js'

export { PRUNE_WORKFLOW_VERSION }
export const PRUNE_BATCH_SIZE = 100
const LEGACY_ORDERING_VERSION = 1
const DESTINATION_LOOKUP_CONCURRENCY = 16

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

function normalizeTargetBytes (data, limit) {
  if (data?.targetBytes === undefined) return getPruneTargetBytes(limit)
  if (!Number.isFinite(data.targetBytes) || data.targetBytes < 0) {
    throw new TypeError('Invalid pruneCheck targetBytes')
  }
  return Math.min(limit, data.targetBytes)
}

function resolvePrunePolicy (data, owner) {
  const dynamicLimit = data.resolveLimitFromOwner === true
  const limit = dynamicLimit
    ? getStorageLimit(owner?.popularityLevel)
    : Math.max(0, data.limit)
  return {
    limit,
    targetBytes: dynamicLimit
      ? getPruneTargetBytes(limit)
      : normalizeTargetBytes(data, limit),
    pruningStarted: data.pruningStarted === true ||
      (Number.isSafeInteger(data.step) && data.step > 0)
  }
}

export function getPruneCheckCoalescingKey (op) {
  const data = op?.data
  if (op?.type !== 'pruneCheck' ||
      (op.phase || 'queued') !== 'queued' ||
      !isValidPrimaryKey(data?.key) ||
      !['ip', 'pubkey'].includes(data?.entityType) ||
      !Number.isFinite(data?.limit) ||
      data.limit < 0 ||
      (data.targetBytes !== undefined &&
        (!Number.isFinite(data.targetBytes) || data.targetBytes < 0))) {
    return null
  }

  const limit = Math.max(0, data.limit)
  const targetBytes = data.resolveLimitFromOwner === true
    ? 'current'
    : normalizeTargetBytes(data, limit)
  const staleCutoff = Number.isFinite(data.staleIfLastActiveAtLte)
    ? data.staleIfLastActiveAtLte
    : null
  return JSON.stringify([
    data.key,
    data.entityType,
    limit,
    targetBytes,
    data.resolveLimitFromOwner === true,
    data.deleteOwnerWhenEmpty === true,
    staleCutoff
  ])
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

function actionIdentityFilter (actions, extra = '') {
  return actions
    .map(action => (
      `(ref = ${mdb.toMeiliValue(action.ref)} AND ` +
      `id = ${mdb.toMeiliValue(action.id)}${extra})`
    ))
    .join(' OR ')
}

async function applyActions (actions, { signal } = {}) {
  const deletions = actions.filter(action => action.action === 'delete')
  const promotions = actions.filter(action => action.action === 'promote')
  const mutations = []
  checkpoint(signal)
  if (deletions.length) {
    mutations.push(mdb.index('events').deleteDocuments({
      filter: actionIdentityFilter(deletions)
    }))
  }
  if (promotions.length) {
    mutations.push(mdb.index('events').updateDocumentsByFunction({
      function: `
        for action in context.actions {
          if doc.ref == action.ref &&
             doc.id == action.id &&
             doc.ownerType == "ip" {
            doc.ownerType = "pubkey";
            doc.popularityLevel = action.popularityLevel;
          }
        }
        doc
      `,
      filter: actionIdentityFilter(promotions, ' AND ownerType = "ip"'),
      context: {
        actions: promotions.map(action => ({
          ref: action.ref,
          id: action.id,
          popularityLevel: action.destinationPopularityLevel
        }))
      }
    }))
  }
  await Promise.all(mutations)

  checkpoint(signal)
  const refs = [...new Set(actions.map(action => action.ref))]
  const { results } = await mdb.index('events').getDocuments({
    filter: `ref IN [${refs.map(ref => mdb.toMeiliValue(ref)).join(', ')}]`,
    fields: ['ref', 'id', 'ownerType', 'popularityLevel'],
    limit: refs.length
  })
  const currentByRef = new Map(results.map(event => [event.ref, event]))
  const applied = []
  for (const action of actions) {
    const current = currentByRef.get(action.ref)
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
    if (current.ownerType !== 'pubkey' ||
        current.popularityLevel !== action.destinationPopularityLevel) {
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

async function mapWithConcurrency (values, concurrency, mapper) {
  const results = new Array(values.length)
  let nextIndex = 0
  async function worker () {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await mapper(values[index], index)
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker()
    )
  )
  return results
}

export async function queuePruneChecksOnce (requests, { signal } = {}) {
  const byKey = new Map()
  for (const request of requests) {
    const dedupeScope = request.dedupeScope || request.source || 'owner-limit'
    const key = deterministicPruneKey(dedupeScope, request.ownerKey)
    if (!byKey.has(key)) byKey.set(key, { ...request, key })
  }
  const candidates = [...byKey.values()]
  const existence = await mapWithConcurrency(
    candidates,
    DESTINATION_LOOKUP_CONCURRENCY,
    async candidate => {
      checkpoint(signal)
      try {
        await mdb.index('pendingOps').getDocument(candidate.key)
        return true
      } catch (error) {
        if (isNotFound(error)) return false
        throw error
      }
    }
  )

  const missing = candidates.filter((_, index) => !existence[index])
  if (missing.length) {
    checkpoint(signal)
    await queueOps(missing.map(request => ({
      key: request.key,
      type: 'pruneCheck',
      source: request.source,
      data: {
        key: request.ownerKey,
        entityType: request.ownerType,
        limit: request.limit,
        targetBytes: request.targetBytes ??
          getPruneTargetBytes(request.limit),
        popularityLevel: request.popularityLevel,
        workflowVersion: PRUNE_WORKFLOW_VERSION,
        step: 0,
        deleteOwnerWhenEmpty: request.deleteOwnerWhenEmpty === true,
        resolveLimitFromOwner: request.resolveLimitFromOwner === true,
        ...(Number.isFinite(request.staleIfLastActiveAtLte)
          ? { staleIfLastActiveAtLte: request.staleIfLastActiveAtLte }
          : {})
      }
    })))
  }

  const queuedKeys = new Set(missing.map(request => request.key))
  return candidates.map(request => ({
    key: request.key,
    queued: queuedKeys.has(request.key)
  }))
}

export async function queuePruneCheckOnce (request) {
  const [result] = await queuePruneChecksOnce([request], {
    signal: request.signal
  })
  return result
}

async function queueDestinationChecks (applied, { signal } = {}) {
  const destinations = new Map()
  for (const action of applied) {
    if (action.action !== 'promote') continue
    destinations.set(action.destinationOwnerKey, {
      ownerKey: action.destinationOwnerKey,
      popularityLevel: action.destinationPopularityLevel
    })
  }

  const requests = [...destinations.values()]
    .filter(destination => !VIP_PUBKEYS.has(destination.ownerKey))
    .map(destination => ({
      ownerKey: destination.ownerKey,
      ownerType: 'pubkey',
      limit: getStorageLimit(destination.popularityLevel),
      popularityLevel: destination.popularityLevel,
      source: 'prunePromotion',
      dedupeScope: 'prune-promotion-destination',
      resolveLimitFromOwner: true
    }))
  const results = await queuePruneChecksOnce(requests, { signal })
  return {
    destinations: requests.length,
    queuedDestinations: results.filter(result => result.queued).length
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
    return 'finished'
  }
  if (!isStillStale(owner, data)) {
    await deletePendingOp(op.key)
    return 'finished'
  }

  const { limit, targetBytes } = resolvePrunePolicy(data, owner)
  if ((owner.usedBytes || 0) > targetBytes) {
    const base = workflowBaseData(data)
    await patchPendingOp(op, 'queued', {
      ...base,
      limit,
      targetBytes,
      workflowVersion: PRUNE_WORKFLOW_VERSION,
      pruningStarted: true,
      step: (data.step || 0) + 1
    })
    return 'continued'
  }

  await maybeDeleteEmptyOwner(data.key, data, { signal })
  checkpoint(signal)
  await deletePendingOp(op.key)
  return 'finished'
}

async function handleNoActions (op, data, owner, { signal } = {}) {
  if ((data.workflowVersion || 0) < LEGACY_ORDERING_VERSION &&
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
  const startedProcessingAt = Date.now()
  const timings = {
    selectionMs: 0,
    mutationMs: 0,
    accountingMs: 0,
    destinationMs: 0
  }
  checkpoint(signal)
  const data = op.data || {}
  if (!isValidPrimaryKey(data.key) ||
      !['ip', 'pubkey'].includes(data.entityType) ||
      !Number.isFinite(data.limit) ||
      data.limit < 0 ||
      (data.targetBytes !== undefined &&
        (!Number.isFinite(data.targetBytes) || data.targetBytes < 0))) {
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
    const policy = resolvePrunePolicy(data, owner)
    const normalizedData = {
      ...data,
      limit: policy.limit,
      targetBytes: policy.targetBytes,
      workflowVersion: PRUNE_WORKFLOW_VERSION,
      pruningStarted: policy.pruningStarted,
      resolveLimitFromOwner: false
    }
    const stopAtBytes = policy.pruningStarted
      ? policy.targetBytes
      : policy.limit
    if ((owner.usedBytes || 0) <= stopAtBytes) {
      await maybeDeleteEmptyOwner(data.key, data, { signal })
      await deletePendingOp(op.key)
      return
    }

    const selectingAt = Date.now()
    const actions = await selectActions({
      ownerKey: data.key,
      ownerType: data.entityType,
      signal
    })
    timings.selectionMs += Date.now() - selectingAt
    if (!actions.length) {
      await handleNoActions(op, normalizedData, owner, { signal })
      return
    }

    const step = Number.isSafeInteger(data.step) ? data.step : 0
    await patchPendingOp(op, 'prepared', {
      ...workflowBaseData(normalizedData),
      workflowVersion: PRUNE_WORKFLOW_VERSION,
      pruningStarted: true,
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
    const mutatingAt = Date.now()
    const applied = await applyActions(op.data.actions || [], { signal })
    timings.mutationMs += Date.now() - mutatingAt
    await patchPendingOp(op, 'events_applied', {
      ...op.data,
      applied
    })
  }

  if (op.phase === 'events_applied') {
    const deltas = usageDeltas(op.data.applied || [])
    checkpoint(signal)
    const accountingAt = Date.now()
    await applyStoredUsageDeltasOnce(deltas, op.data.effectKey, { signal })
    await patchPendingOp(op, 'accounting_applied', {
      ...op.data,
      deltas
    })
    timings.accountingMs += Date.now() - accountingAt
  }

  if (op.phase === 'accounting_applied') {
    checkpoint(signal)
    const destinationAt = Date.now()
    const destinationResult = await queueDestinationChecks(
      op.data.applied || [],
      { signal }
    )
    timings.destinationMs += Date.now() - destinationAt
    const accountingAt = Date.now()
    await clearStoredUsageDeltaTokens(
      op.data.deltas || [],
      op.data.effectKey,
      { signal }
    )
    const result = await finishOrContinue(op, op.data, { signal })
    timings.accountingMs += Date.now() - accountingAt

    if (process.env.NODE_ENV === 'production' &&
        (op.data.applied || []).length) {
      const applied = op.data.applied || []
      console.log('[pending-ops][prune]', JSON.stringify({
        key: op.key,
        step: op.data.step || 0,
        actions: applied.length,
        deletions: applied.filter(action => action.action === 'delete').length,
        promotions: applied.filter(action => action.action === 'promote').length,
        destinations: destinationResult.destinations,
        queuedDestinations: destinationResult.queuedDestinations,
        result,
        ...timings,
        totalMs: Date.now() - startedProcessingAt
      }))
    }
  }
}
