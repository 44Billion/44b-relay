import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

// Mock Rate Limiter
mock.module('#services/rate-limiting/web-socket-request-limiter.js', {
  namedExports: {
    rateLimitReqByPubkey: mock.fn(() => ({ isRateLimited: false })),
    disconnectWhenInactive: mock.fn()
  }
})

// Import MDB Client to seed data; it already waits for mdb connectivity
const { default: client } = await import('#services/db/mdb.js')
const { default: ReqHandler } = await import('#services/relay/nostr-message-handler/req-handler.js')
const { eventToRecord } = await import('#models/event/mapper.js')

describe('ReqHandler', () => {
  beforeEach(async () => {
    // Seed Meilisearch
    const index = client.index('events')
    await index.deleteAllDocuments()

    // Create valid records using mapper
    const events = [
      { id: '0000000000000000000000000000000000000000000000000000000000000001', kind: 1, pubkey: '000000000000000000000000000000000000000000000000000000000000000a', created_at: 1000, content: 'Hello', tags: [], sig: 'sig1' },
      { id: '0000000000000000000000000000000000000000000000000000000000000002', kind: 1, pubkey: '000000000000000000000000000000000000000000000000000000000000000b', created_at: 1001, content: 'World', tags: [], sig: 'sig2' },
      { id: '0000000000000000000000000000000000000000000000000000000000000003', kind: 1, pubkey: '000000000000000000000000000000000000000000000000000000000000000c', created_at: 1002, content: 'Spam', tags: [], sig: 'sig3' }
    ]
    const records = [
      { ...eventToRecord(events[0], { isContentSearchable: true }), popularityLevel: 6 },
      { ...eventToRecord(events[1], { isContentSearchable: true }), popularityLevel: 6 },
      { ...eventToRecord(events[2], { isContentSearchable: true }), popularityLevel: 999 }
    ]

    await index.addDocuments(records)
    // Wait for indexing
    await new Promise(resolve => setTimeout(resolve, 500))
  })

  afterEach(() => {
    mock.reset()
  })

  const createWs = () => ({
    nostr: {
      pubkey: 'pubkey123',
      subscriptions: {}
    },
    req: { socket: { remoteAddress: '127.0.0.1' } },
    send: mock.fn(),
    close: mock.fn(),
    ip: '127.0.0.1',
    readyState: 1 // OPEN
  })

  it('should return events matching filter', async () => {
    const ws = createWs()
    const filters = [{ authors: ['000000000000000000000000000000000000000000000000000000000000000a'], kinds: [1] }]
    const message = ['REQ', 'sub1', ...filters]

    const handler = new ReqHandler({ wss: {}, ws, nostrMessage: message })
    await handler.run()

    // Expect EVENT message
    const calls = ws.send.mock.calls
    const headers = calls.map(c => JSON.parse(c.arguments[0])[0])

    // Should get EVENT and EOSE
    assert.ok(headers.includes('EVENT'))
    assert.ok(headers.includes('EOSE'))

    const eventMsg = calls.find(c => JSON.parse(c.arguments[0])[0] === 'EVENT')
    const payload = JSON.parse(eventMsg.arguments[0])
    assert.equal(payload[1], 'sub1')
    assert.equal(payload[2].id, '0000000000000000000000000000000000000000000000000000000000000001')
  })

  it('should restrict broad filters to popularity level 6', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      const ws = createWs()
      // Broad filter: only kinds
      const filters = [{ kinds: [1] }]
      const message = ['REQ', 'sub_broad', ...filters]

      const handler = new ReqHandler({ wss: {}, ws, nostrMessage: message })
      await handler.run()

      const eventMsgs = ws.send.mock.calls
        .map(c => JSON.parse(c.arguments[0]))
        .filter(m => m[0] === 'EVENT')

      // Should find events 1 and 2 (popularity 6) but NOT 3 (popularity 999)
      assert.equal(eventMsgs.length, 2)
      const ids = eventMsgs.map(m => m[2].id)
      assert.ok(ids.includes('0000000000000000000000000000000000000000000000000000000000000001'))
      assert.ok(ids.includes('0000000000000000000000000000000000000000000000000000000000000002'))
      assert.ok(!ids.includes('0000000000000000000000000000000000000000000000000000000000000003'))
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should allow spam events in broad filters if include:spam is provided', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      const ws = createWs()
      // Broad filter with include:spam
      const filters = [{ kinds: [1], search: 'include:spam' }]
      const message = ['REQ', 'sub_spam', ...filters]

      const handler = new ReqHandler({ wss: {}, ws, nostrMessage: message })
      await handler.run()

      const eventMsgs = ws.send.mock.calls
        .map(c => JSON.parse(c.arguments[0]))
        .filter(m => m[0] === 'EVENT')

      // Should find all 3 events
      assert.equal(eventMsgs.length, 3)
      const ids = eventMsgs.map(m => m[2].id)
      assert.ok(ids.includes('0000000000000000000000000000000000000000000000000000000000000003'))
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should block overly broad scraper filters', async () => {
    const ws = createWs()
    // Scraper filter: empty or just limit/since/until
    const filters = [{ limit: 10 }]
    const message = ['REQ', 'sub_scraper', ...filters]

    const handler = new ReqHandler({ wss: {}, ws, nostrMessage: message })
    await handler.run()

    const calls = ws.send.mock.calls.map(c => JSON.parse(c.arguments[0]))
    const closedMsg = calls.find(m => m[0] === 'CLOSED')

    assert.ok(closedMsg)
    assert.equal(closedMsg[1], 'sub_scraper')
    assert.match(closedMsg[2], /overly broad filters are not allowed/)

    // Should NOT have any EVENT messages
    assert.ok(!calls.some(m => m[0] === 'EVENT'))
  })
})
