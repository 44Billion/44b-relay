import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import * as deleteExpiredEventsJob from '#models/job/jobs/delete-expired-events.js'

describe('Job: Delete Expired Events', () => {
  beforeEach(async () => {
    await mdb.index('events').deleteAllDocuments()
  })

  it('should delete expired events', async () => {
    // 1. Seed events
    // We need to know what "expired" means.
    // Assuming deleteExpiredEvents uses 'expiration' tag or kind 40 etc.
    // Or straightforward NIP-40 expiration.
    const now = Math.floor(Date.now() / 1000)

    // Event with expiration in past
    const expiredEvent = {
      ref: 'expired1',
      id: 'expired1',
      pubkey: 'pk1',
      created_at: now - 1000,
      kind: 1,
      expiresAt: now - 500,
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
      tags: [],
      content: 'infinite',
      sig: 'sig',
      ownerType: 'pubkey'
    }

    await mdb.index('events').addDocuments([expiredEvent, validEvent, infiniteEvent])
    await new Promise(resolve => setTimeout(resolve, 100))

    // Run
    await deleteExpiredEventsJob.run()
    await new Promise(resolve => setTimeout(resolve, 100))

    // Assert
    const { results } = await mdb.index('events').getDocuments()
    assert.equal(results.length, 2)
    assert.ok(results.find(e => e.id === 'valid1'))
    assert.ok(results.find(e => e.id === 'infinite1'))
    assert.ok(!results.find(e => e.id === 'expired1'))
  })

  it('config should have correct structure', () => {
    assert.equal(deleteExpiredEventsJob.default.key, 'deleteExpiredEvents')
    assert.equal(typeof deleteExpiredEventsJob.default.run, 'function')
  })
})
