import { describe, it, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import {
  getEventByRef,
  patchEventByRef,
  putEventByRef,
  getEvents,
  countEvents,
  upsertEvent,
  deleteEventsById,
  deleteEventsByRef,
  deleteExpiredEvents
} from '#models/event/dao.js'
import { idToRef } from '#models/event/mapper.js'

describe('Event DAO', () => {
  const baseEvent = {
    id: '1111111111111111111111111111111111111111111111111111111111111111',
    pubkey: '2222222222222222222222222222222222222222222222222222222222222222',
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [['t', 'test']],
    content: 'hello world',
    sig: '33333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333'
  }

  const ref = idToRef(baseEvent.id)

  before(async () => {
    // Migration is already done by mdb.js init
    // Just ensure index is empty
    await mdb.index('events').deleteAllDocuments()
  })

  afterEach(async () => {
    await mdb.index('events').deleteAllDocuments()
  })

  it('upsertEvent should store a new event', async () => {
    const { success, isPersisted, result } = await upsertEvent(baseEvent)
    assert.strictEqual(success, true)
    assert.strictEqual(isPersisted, true)
    assert.strictEqual(result.id, baseEvent.id)

    const { result: fetched } = await getEventByRef(ref)
    assert.strictEqual(fetched.id, baseEvent.id)
  })

  it('upsertEvent should NOT store an expired event', async () => {
    const expiredEvent = {
      ...baseEvent,
      id: '4'.repeat(64),
      tags: [['expiration', (Math.floor(Date.now() / 1000) - 1).toString()]]
    }
    const { success, isPersisted } = await upsertEvent(expiredEvent)
    assert.strictEqual(success, true)
    assert.strictEqual(isPersisted, false)

    const { success: fetchSuccess } = await getEventByRef(idToRef(expiredEvent.id))
    assert.strictEqual(fetchSuccess, false)
  })

  it('getEventByRef should return an event if it exists', async () => {
    await upsertEvent(baseEvent)
    const { success, result } = await getEventByRef(ref)
    assert.strictEqual(success, true)
    assert.strictEqual(result.id, baseEvent.id)
    assert.strictEqual(result.content, baseEvent.content)
  })

  it('getEventByRef should return error if event does not exist', async () => {
    const { success, error, result } = await getEventByRef('non-existent')
    assert.strictEqual(success, false)
    assert.ok(error)
    assert.strictEqual(result, null)
  })

  it('patchEventByRef should update metadata using Rhai function', async () => {
    await upsertEvent(baseEvent)

    // We update a field that isn't standard in Nostr but exists in the record
    const { success } = await patchEventByRef(ref, { lastAccessedAt: 999999 })
    assert.strictEqual(success, true)

    const rawRecord = await mdb.index('events').getDocument(ref)
    assert.strictEqual(rawRecord.lastAccessedAt, 999999)
    assert.strictEqual(rawRecord.id, baseEvent.id) // Ensure ID is preserved
  })

  it('patchEventByRef should return error if document not found', async () => {
    const { success, error } = await patchEventByRef('missing', { lastAccessedAt: 1 })
    assert.strictEqual(success, false)
    assert.strictEqual(error.message, 'Event not found')
  })

  it('putEventByRef should upsert a record', async () => {
    const { success } = await putEventByRef(ref, { id: baseEvent.id, kind: 1 })
    assert.strictEqual(success, true)

    const rawRecord = await mdb.index('events').getDocument(ref)
    assert.strictEqual(rawRecord.id, baseEvent.id)
    assert.strictEqual(rawRecord.kind, 1)
  })

  it('getEvents and countEvents should filter correctly', async () => {
    await upsertEvent(baseEvent)
    await upsertEvent({ ...baseEvent, id: 'a'.repeat(64), kind: 2 })

    const { result: events } = await getEvents({ kinds: [1] })
    assert.strictEqual(events.length, 1)
    assert.strictEqual(events[0].id, baseEvent.id)

    const { result: count } = await countEvents({ kinds: [1, 2] })
    assert.strictEqual(count, 2)
  })

  it('getEvents should handle tag filtering', async () => {
    await upsertEvent(baseEvent) // has tag ['t', 'test']

    const { result: events } = await getEvents({ tags: { t: ['test'] } })
    assert.strictEqual(events.length, 1)
    assert.deepStrictEqual(events[0].tags, baseEvent.tags)

    const { result: empty } = await getEvents({ tags: { t: ['missing'] } })
    assert.strictEqual(empty.length, 0)
  })

  it('deleteEventsById should delete by hex id', async () => {
    await upsertEvent(baseEvent)
    const { success } = await deleteEventsById([baseEvent.id])
    assert.strictEqual(success, true)

    const { result: count } = await countEvents({})
    assert.strictEqual(count, 0)
  })

  it('deleteEventsByRef should delete by primary key (ref)', async () => {
    await upsertEvent(baseEvent)
    const { success } = await deleteEventsByRef([ref])
    assert.strictEqual(success, true)

    const { result: count } = await countEvents({})
    assert.strictEqual(count, 0)
  })

  it('deleteExpiredEvents should remove documents where expiresAt <= now', async () => {
    const now = Math.floor(Date.now() / 1000)

    // One expired, one not
    await upsertEvent({ ...baseEvent, id: '1'.repeat(64), tags: [['expiration', (now - 10).toString()]] })
    await upsertEvent({ ...baseEvent, id: '2'.repeat(64), tags: [['expiration', (now + 100).toString()]] })

    const { success } = await deleteExpiredEvents()
    assert.strictEqual(success, true)

    const { result: count } = await countEvents({})
    assert.strictEqual(count, 1)
  })
})
