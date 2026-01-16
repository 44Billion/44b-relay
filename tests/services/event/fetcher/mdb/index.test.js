import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import { eventToRecord } from '#models/event/mapper.js'
import EventFetcher from '#services/event/fetcher/mdb/index.js'

// Helper for valid hex strings
const pad64 = (s) => s.padStart(64, '0')
const VALID_SIG = pad64('abc')
const VALID_PUBKEY = pad64('def')

describe('Event Fetcher (MDB)', () => {
  beforeEach(async () => {
    // Clear DB index 'events' for fresh start
    try {
      await mdb.index('events').deleteAllDocuments()
    } catch (_err) { }
  })

  // Helper to seed events directly into MDB
  const seedEvents = async (events) => {
    const docs = events.map(evt => {
      const record = eventToRecord(evt, { receivedAt: evt.created_at })
      return {
        ...record,
        byteSize: 100, // Dummy
        ownerType: 'pubkey',
        ip: '127.0.0.1',
        popularityLevel: evt.popularityLevel || 0
      }
    })
    await mdb.index('events').addDocuments(docs)
  }

  it('should fetch events based on filter', async () => {
    const event1 = {
      id: pad64('1'),
      pubkey: VALID_PUBKEY,
      created_at: 1000,
      kind: 1,
      tags: [],
      content: 'hello',
      sig: VALID_SIG
    }
    const event2 = {
      id: pad64('2'),
      pubkey: VALID_PUBKEY,
      created_at: 2000,
      kind: 2, // Different kind
      tags: [],
      content: 'world',
      sig: VALID_SIG
    }

    await seedEvents([event1, event2])

    const filters = [{ kinds: [1], limit: 10 }]
    const fetched = []

    for await (const event of EventFetcher.run(filters)) {
      fetched.push(event)
    }

    assert.equal(fetched.length, 1)
    assert.equal(fetched[0].id, event1.id)
    assert.equal(fetched[0].content, event1.content)
  })

  it('should add tags to query correctly', async () => {
    const eventWithTag = {
      id: pad64('3'),
      pubkey: VALID_PUBKEY,
      created_at: 1000,
      kind: 1,
      tags: [['p', 'abc']],
      content: 'tagged',
      sig: VALID_SIG
    }
    const eventWithoutTag = {
      id: pad64('4'),
      pubkey: VALID_PUBKEY,
      created_at: 1000,
      kind: 1,
      tags: [],
      content: 'untagged',
      sig: VALID_SIG
    }

    await seedEvents([eventWithTag, eventWithoutTag])

    const filters = [{ '#p': ['abc'], kinds: [1] }]
    const fetched = []

    for await (const event of EventFetcher.run(filters)) {
      fetched.push(event)
    }

    assert.equal(fetched.length, 1)
    assert.equal(fetched[0].id, eventWithTag.id)
  })

  it('should apply popularityLevel if broad filter allowed', async () => {
    // If the filter is broad, we expect query to include popularityLevel <= 6
    // So if we seed an event with popularityLevel > 6, it should NOT be returned.
    // If we seed an event with popularityLevel <= 6, it SHOULD be returned.

    // Broad Filter: just kinds: [1]

    const popularEvent = {
      id: pad64('5'),
      pubkey: VALID_PUBKEY,
      created_at: 1000,
      kind: 1,
      tags: [],
      content: 'popular',
      sig: VALID_SIG,
      popularityLevel: 6
    }

    const unpopularEvent = {
      id: pad64('6'),
      pubkey: VALID_PUBKEY,
      created_at: 1000,
      kind: 1,
      tags: [],
      content: 'unpopular',
      sig: VALID_SIG,
      popularityLevel: 7 // > 6
    }

    await seedEvents([popularEvent, unpopularEvent])

    const filters = [{ kinds: [1] }] // Broad filter
    const fetched = []

    for await (const event of EventFetcher.run(filters)) {
      fetched.push(event)
    }

    // Should only fetch the one with level <= 6
    assert.equal(fetched.length, 1)
    assert.equal(fetched[0].id, popularEvent.id)
  })

  it('should sort events from newest to oldest by default', async () => {
    const olderEvent = {
      id: pad64('10'),
      pubkey: VALID_PUBKEY,
      created_at: 1000,
      kind: 1,
      tags: [],
      content: 'older',
      sig: VALID_SIG
    }
    const newerEvent = {
      id: pad64('11'),
      pubkey: VALID_PUBKEY,
      created_at: 2000,
      kind: 1,
      tags: [],
      content: 'newer',
      sig: VALID_SIG
    }
    const middleEvent = {
      id: pad64('12'),
      pubkey: VALID_PUBKEY,
      created_at: 1500,
      kind: 1,
      tags: [],
      content: 'middle',
      sig: VALID_SIG
    }

    await seedEvents([olderEvent, newerEvent, middleEvent])

    const filters = [{ kinds: [1] }] // No limit
    const fetched = []

    for await (const event of EventFetcher.run(filters)) {
      fetched.push(event)
    }

    assert.equal(fetched.length, 3)
    assert.equal(fetched[0].id, newerEvent.id)
    assert.equal(fetched[1].id, middleEvent.id)
    assert.equal(fetched[2].id, olderEvent.id)
  })

  it('should sort events from newest to oldest when fetching by ids', async () => {
    const olderEvent = {
      id: pad64('10'),
      pubkey: VALID_PUBKEY,
      created_at: 1000,
      kind: 1,
      tags: [],
      content: 'older',
      sig: VALID_SIG
    }
    const newerEvent = {
      id: pad64('11'),
      pubkey: VALID_PUBKEY,
      created_at: 2000,
      kind: 1,
      tags: [],
      content: 'newer',
      sig: VALID_SIG
    }

    await seedEvents([olderEvent, newerEvent])

    const filters = [{ ids: [olderEvent.id, newerEvent.id] }]
    const fetched = []

    for await (const event of EventFetcher.run(filters)) {
      fetched.push(event)
    }

    assert.equal(fetched.length, 2)
    assert.equal(fetched[0].id, newerEvent.id)
    assert.equal(fetched[1].id, olderEvent.id)
  })

  it('should sort events from newest to oldest when fetching by shuffled ids', async () => {
    const e1 = { id: pad64('1'), pubkey: VALID_PUBKEY, created_at: 1000, kind: 1, tags: [], content: '1', sig: VALID_SIG }
    const e2 = { id: pad64('2'), pubkey: VALID_PUBKEY, created_at: 2000, kind: 1, tags: [], content: '2', sig: VALID_SIG }
    const e3 = { id: pad64('3'), pubkey: VALID_PUBKEY, created_at: 3000, kind: 1, tags: [], content: '3', sig: VALID_SIG }

    await seedEvents([e1, e2, e3])

    // IDs in random order (e.g. 1, 3, 2)
    const filters = [{ ids: [e1.id, e3.id, e2.id] }]
    const fetched = []

    for await (const event of EventFetcher.run(filters)) {
      fetched.push(event)
    }

    assert.equal(fetched.length, 3)
    assert.equal(fetched[0].id, e3.id)
    assert.equal(fetched[1].id, e2.id)
    assert.equal(fetched[2].id, e1.id)
  })
})
