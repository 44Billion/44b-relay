import { beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import { queueOps } from '#services/event/maintainer/mdb/index.js'
import { loadSystemState, processBatch } from '#models/job/jobs/process-pending-ops/index.js'
import {
  authorKey,
  GLOBAL_KEY,
  getManifestPoolUsage,
  prepareManifestReservation,
  reconcileManifestPoolUsage,
  recoverManifestReservations,
  reserveManifestCapacity
} from '#services/event/manifest-pool.js'
import { queueDeleteEventsWithAccounting } from '#services/event/pending-workflows.js'

const pubkey = 'a'.repeat(64)

function manifest ({ id, byteSize, createdAt = 100 }) {
  return {
    ref: 'manifest_ref',
    id,
    pubkey,
    kind: 35128,
    created_at: createdAt,
    byteSize,
    ownerType: 'pubkey'
  }
}

async function queueManifest (document, reservationKey) {
  await queueOps([{
    type: 'upsertManifestWithReservation',
    reservationKey,
    data: { document, reservationKey }
  }])
}

async function processAllPending () {
  while (true) {
    const { hits } = await mdb.index('pendingOps').search('', {
      limit: 100,
      sort: ['createdAt:asc', 'batchId:asc', 'position:asc', 'key:asc']
    })
    if (!hits.length) return
    await processBatch(hits, await loadSystemState())
  }
}

describe('durable manifest workflows', () => {
  beforeEach(async () => {
    await Promise.all([
      mdb.index('events').deleteAllDocuments(),
      mdb.index('pendingOps').deleteAllDocuments(),
      mdb.index('manifestPoolUsage').deleteAllDocuments(),
      mdb.index('manifestPoolReservations').deleteAllDocuments(),
      mdb.index('storedEventOwners').deleteAllDocuments()
    ])
  })

  it('keeps a reservation until the manifest upsert is confirmed', async () => {
    const document = manifest({ id: '1'.repeat(64), byteSize: 120 })
    const reservation = await reserveManifestCapacity({
      pubkey,
      newBytes: document.byteSize,
      eventId: document.id,
      ref: document.ref
    })
    await queueManifest(document, reservation.reservationKey)
    await processAllPending()

    assert.equal((await mdb.index('events').getDocument(document.ref)).id, document.id)
    const storedReservation = await mdb.index('manifestPoolReservations').getDocument(reservation.reservationKey)
    assert.equal(storedReservation.state, 'committed')
    const usage = await getManifestPoolUsage()
    assert.equal(usage.global.logicalBytes, 120)
    assert.equal(usage.global.manifestCount, 1)
    assert.deepEqual(usage.global.reservationTokens, [])
  })

  it('accounts duplicate concurrent submissions only once', async () => {
    const document = manifest({ id: '2'.repeat(64), byteSize: 90 })
    const reservations = await Promise.all([0, 1].map(() => reserveManifestCapacity({
      pubkey,
      newBytes: document.byteSize,
      eventId: document.id,
      ref: document.ref
    })))
    await Promise.all(reservations.map(reservation => queueManifest(document, reservation.reservationKey)))
    await processAllPending()

    const states = await Promise.all(reservations.map(reservation => (
      mdb.index('manifestPoolReservations').getDocument(reservation.reservationKey).then(v => v.state)
    )))
    assert.deepEqual(states.sort(), ['cancelled', 'committed'])
    const usage = await getManifestPoolUsage()
    assert.equal(usage.global.logicalBytes, 90)
    assert.equal(usage.global.manifestCount, 1)
  })

  it('applies a size reduction only after replacement succeeds', async () => {
    const oldDocument = manifest({ id: '3'.repeat(64), byteSize: 200, createdAt: 100 })
    const newDocument = manifest({ id: '4'.repeat(64), byteSize: 80, createdAt: 101 })
    await mdb.index('events').addDocuments([oldDocument])
    await reconcileManifestPoolUsage()

    const reservation = await reserveManifestCapacity({
      pubkey,
      newBytes: newDocument.byteSize,
      oldBytes: oldDocument.byteSize,
      isReplacement: true,
      eventId: newDocument.id,
      ref: newDocument.ref,
      oldEventId: oldDocument.id
    })
    assert.equal((await getManifestPoolUsage()).global.logicalBytes, 200)
    await queueManifest(newDocument, reservation.reservationKey)
    await processAllPending()
    assert.equal((await getManifestPoolUsage()).global.logicalBytes, 80)
  })

  it('cancels capacity after an irrecoverable malformed upsert', async () => {
    const reservation = await reserveManifestCapacity({
      pubkey,
      newBytes: 70,
      eventId: '5'.repeat(64),
      ref: 'manifest_ref'
    })
    await queueOps([{
      type: 'upsertManifestWithReservation',
      reservationKey: reservation.reservationKey,
      data: { document: { id: '5'.repeat(64) }, reservationKey: reservation.reservationKey }
    }])
    await processAllPending()

    assert.equal((await getManifestPoolUsage()).global.logicalBytes, 0)
    assert.equal(
      (await mdb.index('manifestPoolReservations').getDocument(reservation.reservationKey)).state,
      'cancelled'
    )
  })

  it('keeps a started upsert queued after a network failure', async () => {
    const document = { ...manifest({ id: 'b'.repeat(64), byteSize: 55 }), ref: 'network_ref' }
    const reservation = await reserveManifestCapacity({
      pubkey,
      newBytes: document.byteSize,
      eventId: document.id,
      ref: document.ref
    })
    await queueManifest(document, reservation.reservationKey)
    const { hits } = await mdb.index('pendingOps').search('', { limit: 1 })
    const eventsIndex = mdb.index('events')
    const addMock = mock.method(eventsIndex, 'addDocuments', async () => {
      const error = new Error('network unavailable')
      error.name = 'MeiliSearchCommunicationError'
      throw error
    })
    try {
      await assert.rejects(
        processBatch(hits, await loadSystemState()),
        { name: 'MeiliSearchCommunicationError' }
      )
    } finally {
      addMock.mock.restore()
    }

    const pending = await mdb.index('pendingOps').getDocument(hits[0].key)
    assert.equal(pending.phase, 'prepared')
    assert.equal(
      (await mdb.index('manifestPoolReservations').getDocument(reservation.reservationKey)).state,
      'prepared'
    )
    await processAllPending()
    assert.equal((await mdb.index('events').getDocument(document.ref)).id, document.id)
  })

  it('finishes accounting when persisting the post-upsert phase fails permanently', async () => {
    const document = { ...manifest({ id: 'c'.repeat(64), byteSize: 65 }), ref: 'phase_failure_ref' }
    const reservation = await reserveManifestCapacity({
      pubkey,
      newBytes: document.byteSize,
      eventId: document.id,
      ref: document.ref
    })
    await queueManifest(document, reservation.reservationKey)
    const { hits } = await mdb.index('pendingOps').search('', { limit: 1 })
    const pendingIndex = mdb.index('pendingOps')
    const originalUpdate = pendingIndex.updateDocuments.bind(pendingIndex)
    const updateMock = mock.method(pendingIndex, 'updateDocuments', async documents => {
      if (documents[0]?.phase === 'event_applied') throw new TypeError('invalid phase update')
      return originalUpdate(documents)
    })
    try {
      await processBatch(hits, await loadSystemState())
    } finally {
      updateMock.mock.restore()
    }

    await assert.rejects(mdb.index('pendingOps').getDocument(hits[0].key))
    assert.equal((await mdb.index('events').getDocument(document.ref)).id, document.id)
    assert.equal(
      (await mdb.index('manifestPoolReservations').getDocument(reservation.reservationKey)).state,
      'committed'
    )
    assert.equal((await getManifestPoolUsage()).global.logicalBytes, 65)
  })

  it('recovers both orphaned and already-applied reservations', async () => {
    const orphan = await reserveManifestCapacity({
      pubkey,
      newBytes: 40,
      eventId: '6'.repeat(64),
      ref: 'orphan_ref'
    })
    const appliedDocument = { ...manifest({ id: '7'.repeat(64), byteSize: 60 }), ref: 'applied_ref' }
    const applied = await reserveManifestCapacity({
      pubkey,
      newBytes: appliedDocument.byteSize,
      eventId: appliedDocument.id,
      ref: appliedDocument.ref
    })
    await prepareManifestReservation(applied.reservationKey, {
      actualDeltaBytes: 60,
      actualDeltaCount: 1,
      state: 'prepared'
    })
    await mdb.index('events').addDocuments([appliedDocument])

    await recoverManifestReservations({ orphanGraceMs: 0 })
    assert.equal((await mdb.index('manifestPoolReservations').getDocument(orphan.reservationKey)).state, 'cancelled')
    assert.equal((await mdb.index('manifestPoolReservations').getDocument(applied.reservationKey)).state, 'committed')
    assert.equal((await getManifestPoolUsage()).global.logicalBytes, 60)
  })

  it('finishes an author settlement after a crash between both counters', async () => {
    const document = { ...manifest({ id: 'a'.repeat(64), byteSize: 75 }), ref: 'partial_ref' }
    const reservation = await reserveManifestCapacity({
      pubkey,
      newBytes: document.byteSize,
      eventId: document.id,
      ref: document.ref
    })
    await prepareManifestReservation(reservation.reservationKey, {
      actualDeltaBytes: 75,
      actualDeltaCount: 1,
      state: 'event_applied'
    })
    await mdb.index('events').addDocuments([document])

    const global = await mdb.index('manifestPoolUsage').getDocument(GLOBAL_KEY)
    await Promise.all([
      mdb.index('manifestPoolUsage').updateDocuments([{
        key: GLOBAL_KEY,
        reservationTokens: global.reservationTokens.filter(key => key !== reservation.reservationKey),
        settlementTokens: [`${reservation.reservationKey}:commit`],
        mutationVersion: global.mutationVersion + 1
      }]),
      mdb.index('manifestPoolReservations').updateDocuments([{
        key: reservation.reservationKey,
        globalSettled: true
      }])
    ])

    await recoverManifestReservations({ orphanGraceMs: 0 })
    const stored = await mdb.index('manifestPoolReservations').getDocument(reservation.reservationKey)
    assert.equal(stored.state, 'committed')
    assert.equal(stored.authorSettled, true)
    const usage = await getManifestPoolUsage()
    assert.equal(usage.global.logicalBytes, 75)
    assert.deepEqual(usage.global.settlementTokens, [])
    const author = await mdb.index('manifestPoolUsage').getDocument(authorKey(pubkey))
    assert.equal(author.logicalBytes, 75)
    assert.deepEqual(author.reservationTokens, [])
  })

  it('releases a manifest and pruning metric only once across duplicate deletions', async () => {
    const document = manifest({ id: '8'.repeat(64), byteSize: 100 })
    await mdb.index('events').addDocuments([document])
    await reconcileManifestPoolUsage()
    await Promise.all([
      queueDeleteEventsWithAccounting([document], { pruning: true }),
      queueDeleteEventsWithAccounting([document], { pruning: true })
    ])
    await processAllPending()

    await assert.rejects(mdb.index('events').getDocument(document.ref))
    const usage = await getManifestPoolUsage()
    assert.equal(usage.global.logicalBytes, 0)
    assert.equal(usage.global.manifestCount, 0)
    assert.equal(usage.global.pruningCount, 1)
  })

  it('queues accounting compensation when the event-delete phase cannot be recorded', async () => {
    const document = { ...manifest({ id: 'd'.repeat(64), byteSize: 85 }), ref: 'delete_phase_failure_ref' }
    await mdb.index('events').addDocuments([document])
    await reconcileManifestPoolUsage()
    await queueDeleteEventsWithAccounting([document], { pruning: true })
    const { hits } = await mdb.index('pendingOps').search('', { limit: 1 })
    const pendingIndex = mdb.index('pendingOps')
    const originalUpdate = pendingIndex.updateDocuments.bind(pendingIndex)
    const updateMock = mock.method(pendingIndex, 'updateDocuments', async documents => {
      if (documents[0]?.phase === 'events_deleted') throw new TypeError('invalid phase update')
      return originalUpdate(documents)
    })
    try {
      await processBatch(hits, await loadSystemState())
    } finally {
      updateMock.mock.restore()
    }

    const { hits: compensation } = await mdb.index('pendingOps').search('', { limit: 10 })
    assert.equal(compensation.length, 1)
    assert.equal(compensation[0].source, 'pendingWorkflowCompensation')
    assert.equal(compensation[0].phase, 'events_deleted')
    await processAllPending()
    const usage = await getManifestPoolUsage()
    assert.equal(usage.global.logicalBytes, 0)
    assert.equal(usage.global.pruningCount, 1)
    assert.deepEqual(usage.global.workflowTokens, [])
  })

  it('resumes accounting after a crash following event deletion', async () => {
    const document = {
      ref: 'ordinary_ref',
      id: '9'.repeat(64),
      pubkey,
      kind: 1,
      byteSize: 200,
      ownerType: 'pubkey'
    }
    await Promise.all([
      mdb.index('events').addDocuments([document]),
      mdb.index('storedEventOwners').addDocuments([{
        key: pubkey,
        entityType: 'pubkey',
        usedBytes: 500,
        popularityLevel: 1,
        accountingTokens: []
      }])
    ])
    await queueDeleteEventsWithAccounting([document])
    const { hits } = await mdb.index('pendingOps').search('', { limit: 1 })
    const op = hits[0]
    const selected = [{
      ref: document.ref,
      id: document.id,
      kind: document.kind,
      pubkey,
      byteSize: document.byteSize,
      ownerType: 'pubkey',
      ownerKey: pubkey
    }]
    await mdb.index('events').deleteDocument(document.ref)
    await mdb.index('pendingOps').updateDocuments([{
      key: op.key,
      phase: 'events_deleted',
      startedAt: Date.now(),
      data: { ...op.data, selected }
    }])

    await processAllPending()
    assert.equal((await mdb.index('storedEventOwners').getDocument(pubkey)).usedBytes, 300)
  })
})
