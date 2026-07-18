import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import { processBatch, loadSystemState } from '#models/job/jobs/process-pending-ops/index.js'
import * as deleteExpiredEventsJob from '#models/job/jobs/delete-expired-events.js'
import { ipToPrimaryKey } from '#helpers/mdb.js'
import { eventKinds } from '#constants/event.js'
import { eventToRecord } from '#models/event/mapper.js'
import { getManifestPoolUsage, reconcileManifestPoolUsage } from '#services/event/manifest-pool.js'

const runPendingOps = async () => {
  const { hits } = await mdb.index('pendingOps').search('', { limit: 1000, sort: ['createdAt:asc'] })
  if (hits.length === 0) return
  const state = await loadSystemState()
  await processBatch(hits, state)
}

describe('Job: Delete Expired Events', () => {
  beforeEach(async () => {
    await Promise.all([
      mdb.index('events').deleteAllDocuments(),
      mdb.index('pendingOps').deleteAllDocuments(),
      mdb.index('storedEventOwners').deleteAllDocuments(),
      mdb.index('manifestPoolUsage').deleteAllDocuments()
    ])
  })

  it('should delete expired events', async () => {
    const now = Math.floor(Date.now() / 1000)

    // Event with expiration in past
    const expiredEvent = {
      ref: 'expired1',
      id: 'expired1',
      pubkey: 'pk1',
      created_at: now - 1000,
      kind: 1,
      expiresAt: now - 500,
      byteSize: 200,
      tags: [['expiration', String(now - 500)]],
      content: 'expired',
      sig: 'sig',
      ownerType: 'pubkey'
    }

    // Event with expiration in future
    const validEvent = {
      ref: 'valid1',
      id: 'valid1',
      pubkey: 'pk1',
      created_at: now - 1000,
      kind: 1,
      expiresAt: now + 5000,
      byteSize: 150,
      tags: [['expiration', String(now + 5000)]],
      content: 'valid',
      sig: 'sig',
      ownerType: 'pubkey'
    }

    // Event without expiration
    const infiniteEvent = {
      ref: 'infinite1',
      id: 'infinite1',
      pubkey: 'pk1',
      created_at: now - 1000,
      kind: 1,
      byteSize: 100,
      tags: [],
      content: 'infinite',
      sig: 'sig',
      ownerType: 'pubkey'
    }

    await mdb.index('events').addDocuments([expiredEvent, validEvent, infiniteEvent])
    await new Promise(resolve => setTimeout(resolve, 100))

    // Run job (queues deleteDocumentIfExists + deltaUsage ops)
    await deleteExpiredEventsJob.run()

    // Process the queued ops (deletes + usage updates)
    await runPendingOps()

    await new Promise(resolve => setTimeout(resolve, 100))

    // Assert (filter out __processingState__ doc written by processBatch)
    const { results: allResults } = await mdb.index('events').getDocuments()
    const results = allResults.filter(e => e.ref !== '__processingState__')
    assert.equal(results.length, 2)
    assert.ok(results.find(e => e.id === 'valid1'))
    assert.ok(results.find(e => e.id === 'infinite1'))
    assert.ok(!results.find(e => e.id === 'expired1'))
  })

  it('should decrement usedBytes for pubkey owner when deleting expired events', async () => {
    const now = Math.floor(Date.now() / 1000)
    const pubkey = '0000000000000000000000000000000000000000000000000000000000000099'

    // Seed storedEventOwner with existing usage
    await mdb.index('storedEventOwners').addDocuments([{
      key: pubkey,
      entityType: 'pubkey',
      usedBytes: 500,
      popularityLevel: 3
    }])

    // Seed expired event owned by pubkey
    await mdb.index('events').addDocuments([{
      ref: 'exp_pk1',
      id: 'exp_pk1',
      pubkey,
      created_at: now - 1000,
      kind: 7,
      expiresAt: now - 100,
      byteSize: 200,
      ownerType: 'pubkey',
      content: '',
      sig: 'sig'
    }])

    await new Promise(resolve => setTimeout(resolve, 100))

    // Run job
    await deleteExpiredEventsJob.run()

    // Process the queued deltaUsage ops
    await runPendingOps()

    await new Promise(resolve => setTimeout(resolve, 100))

    // Verify event was deleted
    const { results: events } = await mdb.index('events').getDocuments()
    assert.equal(events.filter(e => e.pubkey === pubkey).length, 0)

    // Verify usedBytes was decremented
    const owner = await mdb.index('storedEventOwners').getDocument(pubkey)
    assert.equal(owner.usedBytes, 300, 'usedBytes should be decremented by 200 (500 - 200 = 300)')
  })

  it('should remove expired private delivery records and decrement their usage', async () => {
    const now = Math.floor(Date.now() / 1000)
    const pubkey = '0000000000000000000000000000000000000000000000000000000000000098'
    const receivedAt = now - (60 * 60 * 24 * 2) - 1
    const events = [
      { id: '8'.repeat(64), kind: eventKinds.PRIVATE_CHANNEL_BROADCAST, byteSize: 200 },
      { id: '9'.repeat(64), kind: eventKinds.GIFT_WRAP, byteSize: 150 }
    ]

    await mdb.index('storedEventOwners').addDocuments([{
      key: pubkey,
      entityType: 'pubkey',
      usedBytes: 500,
      popularityLevel: 999
    }])
    await mdb.index('events').addDocuments(events.map(({ id, kind, byteSize }) => ({
      ...eventToRecord({ id, kind, pubkey, created_at: receivedAt, tags: [], content: '', sig: 'sig' }, { receivedAt }),
      byteSize,
      ownerType: 'pubkey'
    })))

    await new Promise(resolve => setTimeout(resolve, 100))
    await deleteExpiredEventsJob.run()
    await runPendingOps()
    await new Promise(resolve => setTimeout(resolve, 100))

    const { results: eventsAfterCleanup } = await mdb.index('events').getDocuments()
    assert.equal(eventsAfterCleanup.filter(event => event.pubkey === pubkey).length, 0)

    const owner = await mdb.index('storedEventOwners').getDocument(pubkey)
    assert.equal(owner.usedBytes, 150)
  })

  it('should decrement usedBytes for IP owner when deleting expired events', async () => {
    const now = Math.floor(Date.now() / 1000)
    const ip = '10.20.30.40'
    const ipKey = ipToPrimaryKey(ip)

    // Seed storedEventOwner for IP
    await mdb.index('storedEventOwners').addDocuments([{
      key: ipKey,
      entityType: 'ip',
      usedBytes: 1000,
      popularityLevel: 999
    }])

    // Seed expired events owned by IP
    await mdb.index('events').addDocuments([
      {
        ref: 'exp_ip1',
        id: 'exp_ip1',
        pubkey: 'somepk',
        ip,
        created_at: now - 1000,
        kind: 7,
        expiresAt: now - 100,
        byteSize: 300,
        ownerType: 'ip',
        content: '',
        sig: 'sig'
      },
      {
        ref: 'exp_ip2',
        id: 'exp_ip2',
        pubkey: 'somepk',
        ip,
        created_at: now - 500,
        kind: 5,
        expiresAt: now - 50,
        byteSize: 150,
        ownerType: 'ip',
        content: '',
        sig: 'sig'
      }
    ])

    await new Promise(resolve => setTimeout(resolve, 100))

    // Run job
    await deleteExpiredEventsJob.run()

    // Process the queued deltaUsage ops
    await runPendingOps()

    await new Promise(resolve => setTimeout(resolve, 100))

    // Verify events were deleted
    const { results: events } = await mdb.index('events').getDocuments()
    assert.equal(events.filter(e => e.ip === ip).length, 0)

    // Verify usedBytes was decremented
    const owner = await mdb.index('storedEventOwners').getDocument(ipKey)
    assert.equal(owner.usedBytes, 550, 'usedBytes should be decremented by 450 (1000 - 300 - 150 = 550)')
  })

  it('should release expired manifests from the subsidized pool but not ordinary owner usage', async () => {
    const now = Math.floor(Date.now() / 1000)
    const pubkey = 'b'.repeat(64)
    await mdb.index('storedEventOwners').addDocuments([{
      key: pubkey,
      entityType: 'pubkey',
      usedBytes: 500,
      popularityLevel: 3
    }])
    await mdb.index('events').addDocuments([{
      ref: 'expired_manifest',
      id: 'c'.repeat(64),
      pubkey,
      kind: 35128,
      created_at: now - 1000,
      expiresAt: now - 1,
      receivedAt: now - 1000,
      byteSize: 300,
      ownerType: 'pubkey'
    }])
    await reconcileManifestPoolUsage()

    await deleteExpiredEventsJob.run()
    await runPendingOps()

    assert.equal((await getManifestPoolUsage()).global.logicalBytes, 0)
    assert.equal((await mdb.index('storedEventOwners').getDocument(pubkey)).usedBytes, 500)
  })

  it('config should have correct structure', () => {
    assert.equal(deleteExpiredEventsJob.default.key, 'deleteExpiredEvents')
    assert.equal(typeof deleteExpiredEventsJob.default.run, 'function')
  })
})
