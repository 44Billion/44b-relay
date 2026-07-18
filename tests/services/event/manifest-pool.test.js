import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import {
  authorKey,
  cancelManifestReservation,
  GLOBAL_KEY,
  getManifestPoolUsage,
  MANIFEST_POOL_LIMITS,
  reconcileManifestPoolUsage,
  recoverManifestReservations,
  reserveManifestCapacity
} from '#services/event/manifest-pool.js'
import pruneManifestPoolConfig, { findBoundaryScore, pruneManifestPool } from '#models/job/jobs/prune-manifest-pool.js'
import { flushRequestedEventsToMDB, trackRequestedEvents } from '#services/event/tracker/mdb/requested-events.js'
import { loadSystemState, processBatch } from '#models/job/jobs/process-pending-ops/index.js'

function counter (key, { pubkey, logicalBytes = 0, manifestCount = 0 } = {}) {
  return {
    key,
    scope: pubkey ? 'author' : 'global',
    ...(pubkey && { pubkey }),
    logicalBytes,
    manifestCount,
    pruningCount: 0,
    rejectionCount: 0,
    reconciledAt: Math.floor(Date.now() / 1000),
    reservationTokens: []
  }
}

describe('subsidized manifest pool', () => {
  beforeEach(async () => {
    await Promise.all([
      mdb.index('events').deleteAllDocuments(),
      mdb.index('manifestPoolUsage').deleteAllDocuments(),
      mdb.index('manifestPoolReservations').deleteAllDocuments(),
      mdb.index('ipActivities').deleteAllDocuments(),
      mdb.index('pendingOps').deleteAllDocuments()
    ])
  })

  it('uses the configured nominal, target and emergency limits', () => {
    assert.deepEqual(MANIFEST_POOL_LIMITS.global, {
      nominal: 2 * 1024 ** 3,
      target: Math.floor(1.8 * 1024 ** 3),
      emergency: Math.floor(2.2 * 1024 ** 3)
    })
    assert.deepEqual(MANIFEST_POOL_LIMITS.author, {
      nominal: 10 * 1024 ** 2,
      target: 9 * 1024 ** 2,
      emergency: 11 * 1024 ** 2
    })
    assert.equal(pruneManifestPoolConfig.frequency, 300)
    assert.equal(pruneManifestPoolConfig.shouldUseLock, true)
  })

  it('rejects positive inserts over the global emergency limit', async () => {
    const pubkey = '1'.repeat(64)
    await mdb.index('manifestPoolUsage').addDocuments([
      counter(GLOBAL_KEY, { logicalBytes: MANIFEST_POOL_LIMITS.global.emergency - 50 }),
      counter(authorKey(pubkey), { pubkey })
    ])

    const reservation = await reserveManifestCapacity({ pubkey, newBytes: 51 })
    assert.equal(reservation.accepted, false)
    const usage = await getManifestPoolUsage()
    assert.equal(usage.global.logicalBytes, MANIFEST_POOL_LIMITS.global.emergency - 50)
    assert.equal(usage.global.rejectionCount, 1)
  })

  it('does not count a rejection twice when recovery resumes its metric phase', async () => {
    const pubkey = '0'.repeat(64)
    await mdb.index('manifestPoolUsage').addDocuments([
      counter(GLOBAL_KEY, { logicalBytes: MANIFEST_POOL_LIMITS.global.emergency })
    ])
    const result = await reserveManifestCapacity({ pubkey, newBytes: 1 })
    const metricToken = `${result.reservationKey}:rejection:global`
    await Promise.all([
      mdb.index('manifestPoolReservations').updateDocuments([{
        key: result.reservationKey,
        globalRejectionCounted: false
      }]),
      mdb.index('manifestPoolUsage').updateDocuments([{
        key: GLOBAL_KEY,
        metricTokens: [metricToken]
      }])
    ])

    await recoverManifestReservations()
    const usage = await getManifestPoolUsage()
    assert.equal(usage.global.rejectionCount, 1)
    assert.deepEqual(usage.global.metricTokens, [])
    assert.equal(
      (await mdb.index('manifestPoolReservations').getDocument(result.reservationKey)).globalRejectionCounted,
      true
    )
  })

  it('retains rejection semantics when recovering cancel_required', async () => {
    const pubkey = 'f'.repeat(64)
    const result = await reserveManifestCapacity({ pubkey, newBytes: 10 })
    await mdb.index('manifestPoolReservations').updateDocuments([{
      key: result.reservationKey,
      state: 'cancel_required',
      rejectionScope: 'author',
      reason: 'author manifest pool emergency limit reached'
    }])

    await recoverManifestReservations()
    const reservation = await mdb.index('manifestPoolReservations').getDocument(result.reservationKey)
    assert.equal(reservation.state, 'rejected')
    const usage = await getManifestPoolUsage()
    assert.equal(usage.global.logicalBytes, 0)
    assert.equal(usage.global.rejectionCount, 1)
    assert.equal(usage.authors.find(counter => counter.pubkey === pubkey).rejectionCount, 1)
  })

  it('rolls back the global reservation when the author emergency quota rejects it', async () => {
    const pubkey = '2'.repeat(64)
    await mdb.index('manifestPoolUsage').addDocuments([
      counter(GLOBAL_KEY),
      counter(authorKey(pubkey), {
        pubkey,
        logicalBytes: MANIFEST_POOL_LIMITS.author.emergency - 10
      })
    ])

    const reservation = await reserveManifestCapacity({ pubkey, newBytes: 11 })
    assert.equal(reservation.accepted, false)
    const usage = await getManifestPoolUsage()
    assert.equal(usage.global.logicalBytes, 0)
    assert.equal(usage.global.manifestCount, 0)
    assert.equal(usage.authors[0].logicalBytes, MANIFEST_POOL_LIMITS.author.emergency - 10)
  })

  it('permits same-size and smaller replacements during emergency', async () => {
    const pubkey = '3'.repeat(64)
    const aboveEmergency = MANIFEST_POOL_LIMITS.author.emergency + 100
    await mdb.index('manifestPoolUsage').addDocuments([
      counter(GLOBAL_KEY, { logicalBytes: MANIFEST_POOL_LIMITS.global.emergency + 100, manifestCount: 1 }),
      counter(authorKey(pubkey), { pubkey, logicalBytes: aboveEmergency, manifestCount: 1 })
    ])

    assert.equal((await reserveManifestCapacity({ pubkey, newBytes: 1000, oldBytes: 1000, isReplacement: true })).accepted, true)
    assert.equal((await reserveManifestCapacity({ pubkey, newBytes: 999, oldBytes: 1000, isReplacement: true })).accepted, true)
    const usage = await getManifestPoolUsage()
    // Shrinks are applied only after the replacement event is confirmed.
    assert.equal(usage.authors[0].logicalBytes, aboveEmergency)
    assert.equal(usage.authors[0].manifestCount, 1)
  })

  it('keeps concurrent positive reservations below both emergency ceilings', async () => {
    const pubkey = '6'.repeat(64)
    await mdb.index('manifestPoolUsage').addDocuments([
      counter(GLOBAL_KEY, { logicalBytes: MANIFEST_POOL_LIMITS.global.emergency - 500 }),
      counter(authorKey(pubkey), {
        pubkey,
        logicalBytes: MANIFEST_POOL_LIMITS.author.emergency - 500
      })
    ])

    const reservations = await Promise.all(Array.from({ length: 10 }, () => (
      reserveManifestCapacity({ pubkey, newBytes: 100 })
    )))
    assert.equal(reservations.filter(result => result.accepted).length, 5)
    const usage = await getManifestPoolUsage()
    assert.ok(usage.global.logicalBytes <= MANIFEST_POOL_LIMITS.global.emergency)
    assert.ok(usage.authors[0].logicalBytes <= MANIFEST_POOL_LIMITS.author.emergency)
  })

  it('initializes first-use counters without losing concurrent reservations', async () => {
    const pubkey = '8'.repeat(64)
    const reservations = await Promise.all(Array.from({ length: 12 }, () => (
      reserveManifestCapacity({ pubkey, newBytes: 100 })
    )))

    assert.equal(reservations.every(result => result.accepted), true)
    const usage = await getManifestPoolUsage()
    assert.equal(usage.global.logicalBytes, 1200)
    assert.equal(usage.global.manifestCount, 12)
    const author = usage.authors.find(counter => counter.pubkey === pubkey)
    assert.equal(author.logicalBytes, 1200)
    assert.equal(author.manifestCount, 12)
    assert.equal(new Set(usage.global.reservationTokens).size, 12)
  })

  it('defers reconciliation instead of overwriting an active reservation', async () => {
    const pubkey = '9'.repeat(64)
    const reservation = await reserveManifestCapacity({ pubkey, newBytes: 100 })
    await mdb.index('events').addDocuments([{
      ref: 'unrelated_manifest',
      id: 'a'.repeat(64),
      kind: 35128,
      pubkey,
      byteSize: 900
    }])

    const deferred = await reconcileManifestPoolUsage()
    assert.equal(deferred.global.logicalBytes, 100)
    assert.deepEqual(deferred.global.reservationTokens, [reservation.reservationKey])

    await cancelManifestReservation(reservation.reservationKey)
    const reconciled = await reconcileManifestPoolUsage()
    assert.equal(reconciled.global.logicalBytes, 900)
    assert.equal(reconciled.global.manifestCount, 1)
  })

  it('reconciles only manifests from events as the source of truth', async () => {
    const pubkey = '4'.repeat(64)
    await mdb.index('events').addDocuments([
      { ref: 'manifest_a', kind: 35128, pubkey, byteSize: 100 },
      { ref: 'manifest_b', kind: 35129, pubkey, byteSize: 200 },
      { ref: 'ordinary', kind: 1, pubkey, byteSize: 10000 }
    ])

    const usage = await reconcileManifestPoolUsage()
    assert.equal(usage.global.logicalBytes, 300)
    assert.equal(usage.global.manifestCount, 2)
    assert.equal(usage.authors[0].logicalBytes, 300)
  })

  it('finds the exact score boundary without retaining individual candidates', () => {
    assert.deepEqual(findBoundaryScore(new Map([[0, 100], [2, 200], [7, 500]]), 250), {
      score: 2,
      bytesNeededAtBoundary: 150
    })
  })

  it('prunes an over-quota author to the target using deterministic tie ordering', async () => {
    const pubkey = '5'.repeat(64)
    const mib = 1024 ** 2
    await mdb.index('events').addDocuments([
      { ref: 'newer', id: 'newer', kind: 35128, pubkey, byteSize: 4 * mib, receivedAt: 30 },
      { ref: 'old_small', id: 'old_small', kind: 35128, pubkey, byteSize: 4 * mib, receivedAt: 20 },
      { ref: 'oldest', id: 'oldest', kind: 35128, pubkey, byteSize: 4 * mib, receivedAt: 10 }
    ])
    await reconcileManifestPoolUsage()

    const result = await pruneManifestPool()
    assert.equal(result.manifestsScheduled, 1)
    const { hits } = await mdb.index('pendingOps').search('', { limit: 100, sort: ['createdAt:asc', 'batchId:asc', 'position:asc', 'key:asc'] })
    await processBatch(hits, await loadSystemState())
    await assert.rejects(mdb.index('events').getDocument('oldest'))
    assert.equal((await mdb.index('events').getDocument('old_small')).ref, 'old_small')
    const usage = await getManifestPoolUsage()
    assert.equal(usage.global.logicalBytes, 8 * mib)
    assert.equal(usage.global.pruningCount, 1)
  })

  it('prefers a lower request score before age when pruning capacity', async () => {
    const pubkey = '7'.repeat(64)
    const mib = 1024 ** 2
    for (let i = 0; i < 10; i++) trackRequestedEvents({ refs: ['requested_oldest'], ip: '203.0.113.7' })
    await flushRequestedEventsToMDB()
    const { hits } = await mdb.index('pendingOps').search('', { limit: 100, sort: ['createdAt:asc', 'batchId:asc', 'position:asc', 'key:asc'] })
    await processBatch(hits, await loadSystemState())

    await mdb.index('events').addDocuments([
      { ref: 'requested_oldest', id: 'requested_oldest', kind: 35128, pubkey, byteSize: 6 * mib, receivedAt: 10 },
      { ref: 'unrequested_middle', id: 'unrequested_middle', kind: 35128, pubkey, byteSize: 3 * mib, receivedAt: 20 },
      { ref: 'unrequested_newest', id: 'unrequested_newest', kind: 35128, pubkey, byteSize: 3 * mib, receivedAt: 30 }
    ])
    await reconcileManifestPoolUsage()

    await pruneManifestPool()
    const { hits: pruneOps } = await mdb.index('pendingOps').search('', { limit: 100, sort: ['createdAt:asc', 'batchId:asc', 'position:asc', 'key:asc'] })
    await processBatch(pruneOps, await loadSystemState())
    assert.equal((await mdb.index('events').getDocument('requested_oldest')).ref, 'requested_oldest')
    await assert.rejects(mdb.index('events').getDocument('unrequested_middle'))
    assert.equal((await mdb.index('events').getDocument('unrequested_newest')).ref, 'unrequested_newest')
  })
})
