import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import { eventToRecord } from '#models/event/mapper.js'
import EventFetcher from '#services/event/fetcher/mdb/index.js'
import { parseSubscriptionFilters } from '#helpers/subscription.js'

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
      const record = eventToRecord(evt, { receivedAt: evt.created_at, isContentSearchable: true })
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

    const filters = parseSubscriptionFilters({ filters: [{ kinds: [1] }] })
    filters[0].isBroad = true
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

  it('should include spam events only if search has include:spam', async () => {
    // We intentionally disable integration test logic to test "production" behavior of popularity check
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      const normalEvent = {
        id: pad64('10'),
        pubkey: VALID_PUBKEY,
        created_at: 1000,
        kind: 1,
        tags: [],
        content: 'normal',
        sig: VALID_SIG,
        popularityLevel: 6
      }
      const spamEvent = {
        id: pad64('11'),
        pubkey: VALID_PUBKEY,
        created_at: 1100,
        kind: 1,
        tags: [],
        content: 'spam',
        sig: VALID_SIG,
        popularityLevel: 999
      }

      await seedEvents([normalEvent, spamEvent])

      // Broad filter (just kinds) - should return only normal event
      // We parse filters to mimic ReqHandler behavior where broad detection happens
      // Note: isAllowedBroadFilter in BroadStrategy relies on env NOT being integration test
      // and checking filter properties. In test we set a property manually if needed
      // but BroadStrategy uses isAllowedBroadFilter which checks properties.

      const broadFilter = parseSubscriptionFilters({ filters: [{ kinds: [1], limit: 10 }] })
      // Manually flag as broad because ReqHandler usually does this
      broadFilter[0].isBroad = true

      const fetchedNormal = []

      for await (const event of EventFetcher.run(broadFilter)) {
        fetchedNormal.push(event)
      }
      assert.equal(fetchedNormal.length, 1)
      assert.equal(fetchedNormal[0].id, normalEvent.id)

      // Broad filter with include:spam - should return both
      const spamFilter = parseSubscriptionFilters({ filters: [{ kinds: [1], limit: 10, search: 'include:spam' }] })
      spamFilter[0].isBroad = true

      const fetchedSpam = []
      for await (const event of EventFetcher.run(spamFilter)) {
        fetchedSpam.push(event)
      }
      assert.equal(fetchedSpam.length, 2)

      // Broad filter with include:spam AND other query - should strip include:spam
      const searchFilter = parseSubscriptionFilters({ filters: [{ kinds: [1], limit: 10, search: 'include:spam normal' }] })
      searchFilter[0].isBroad = true

      const fetchedSearch = []
      for await (const event of EventFetcher.run(searchFilter)) {
        fetchedSearch.push(event)
      }

      // Should find 'normal' event which is popularity 6.
      // query becomes "normal". Matching normalEvent.
      assert.equal(fetchedSearch.length, 1)
      assert.equal(fetchedSearch[0].id, normalEvent.id)
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should return only spam events if search has is:spam', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      const normalEvent = {
        id: pad64('20'),
        pubkey: VALID_PUBKEY,
        created_at: 1000,
        kind: 1,
        tags: [],
        content: 'normal',
        sig: VALID_SIG,
        popularityLevel: 6
      }
      const spamEvent = {
        id: pad64('21'),
        pubkey: VALID_PUBKEY,
        created_at: 1100,
        kind: 1,
        tags: [],
        content: 'spam',
        sig: VALID_SIG,
        popularityLevel: 999
      }

      await seedEvents([normalEvent, spamEvent])

      // Broad filter with is:spam - should return only the spam event
      const isSpamFilter = parseSubscriptionFilters({ filters: [{ kinds: [1], limit: 10, search: 'is:spam' }] })
      isSpamFilter[0].isBroad = true

      const fetchedSpam = []
      for await (const event of EventFetcher.run(isSpamFilter)) {
        fetchedSpam.push(event)
      }
      assert.equal(fetchedSpam.length, 1)
      assert.equal(fetchedSpam[0].id, spamEvent.id)

      // Broad filter with is:spam AND other query - should strip is:spam
      const searchFilter = parseSubscriptionFilters({ filters: [{ kinds: [1], limit: 10, search: 'is:spam spam' }] })
      searchFilter[0].isBroad = true

      const fetchedSearch = []
      for await (const event of EventFetcher.run(searchFilter)) {
        fetchedSearch.push(event)
      }

      // Should find 'spam' event which has popularityLevel 999.
      // query becomes "spam". Only the spam event matches both text and popularity.
      assert.equal(fetchedSearch.length, 1)
      assert.equal(fetchedSearch[0].id, spamEvent.id)
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })
})
