import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

// Mock dependencies
mock.module('#services/rate-limiting/web-socket-request-limiter.js', {
  namedExports: {
    disconnectWhenInactive: mock.fn()
  }
})

const trackIpActivityMock = mock.fn()
mock.module('#services/event/tracker/mdb/ip-activity.js', {
  namedExports: {
    trackIpActivity: trackIpActivityMock,
    getIpScore: mock.fn(() => 0)
  }
})

// Import MDB Client and CUT
const { default: client } = await import('#services/db/mdb.js')
const { default: CountHandler } = await import('#services/relay/nostr-message-handler/count-handler.js')
const { eventToRecord } = await import('#models/event/mapper.js')

describe('CountHandler', () => {
  beforeEach(async () => {
    // Seed Meilisearch
    const index = client.index('events')
    await index.deleteAllDocuments()

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
    await new Promise(resolve => setTimeout(resolve, 500))
    trackIpActivityMock.mock.resetCalls()
  })

  afterEach(() => {
    mock.reset()
  })

  const createWs = () => ({
    nostr: {
      pubkey: 'pubkey123',
      subscriptions: {}
    },
    send: mock.fn(),
    ip: '127.0.0.1',
    readyState: 1 // OPEN
  })

  it('should return count of events matching filter', async () => {
    const ws = createWs()
    const filters = [{ authors: ['000000000000000000000000000000000000000000000000000000000000000a'], kinds: [1] }]
    const message = ['COUNT', 'sub1', ...filters]

    const handler = new CountHandler({ wss: {}, ws, nostrMessage: message })
    await handler.run()

    const calls = ws.send.mock.calls
    const payload = JSON.parse(calls[0].arguments[0])

    assert.equal(payload[0], 'COUNT')
    assert.equal(payload[1], 'sub1')
    assert.equal(payload[2].count, 1)
    assert.equal(trackIpActivityMock.mock.callCount(), 1)
  })

  it('should return aggregated count for multiple filters', async () => {
    const ws = createWs()
    const filters = [
      { authors: ['000000000000000000000000000000000000000000000000000000000000000a'], kinds: [1] },
      { authors: ['000000000000000000000000000000000000000000000000000000000000000b'], kinds: [1] }
    ]
    const message = ['COUNT', 'sub2', ...filters]

    const handler = new CountHandler({ wss: {}, ws, nostrMessage: message })
    await handler.run()

    const calls = ws.send.mock.calls
    const payload = JSON.parse(calls[0].arguments[0])

    assert.equal(payload[2].count, 2)
  })

  it('should restrict broad filters to popularity level 6', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      const ws = createWs()
      const filters = [{ kinds: [1] }] // Broad filter
      const message = ['COUNT', 'sub_broad', ...filters]

      const handler = new CountHandler({ wss: {}, ws, nostrMessage: message })
      await handler.run()

      const payload = JSON.parse(ws.send.mock.calls[0].arguments[0])
      // Should find events 1 and 2 (popularity 6) but NOT 3 (popularity 999)
      assert.equal(payload[2].count, 2)
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should ignore filters with limit 0', async () => {
    const ws = createWs()
    const filters = [{ authors: ['000000000000000000000000000000000000000000000000000000000000000a'], kinds: [1], limit: 0 }]
    const message = ['COUNT', 'sub_limit0', ...filters]

    const handler = new CountHandler({ wss: {}, ws, nostrMessage: message })
    await handler.run()

    const payload = JSON.parse(ws.send.mock.calls[0].arguments[0])
    assert.equal(payload[2].count, 0)
  })

  it('should send CLOSED if subscriptionId is not a string', async () => {
    const ws = createWs()
    const message = ['COUNT', 123, {}]

    const handler = new CountHandler({ wss: {}, ws, nostrMessage: message })
    await handler.run()

    const payload = JSON.parse(ws.send.mock.calls[0].arguments[0])
    assert.equal(payload[0], 'CLOSED')
    assert.match(payload[2], /wrong subscription id type/)
  })

  it('should send CLOSED for overly broad filters', async () => {
    const ws = createWs()
    const filters = [{ limit: 10 }] // Overly broad
    const message = ['COUNT', 'sub_broad_reject', ...filters]

    const handler = new CountHandler({ wss: {}, ws, nostrMessage: message })
    await handler.run()

    const payload = JSON.parse(ws.send.mock.calls[0].arguments[0])
    assert.equal(payload[0], 'CLOSED')
    assert.match(payload[2], /overly broad filters are not allowed/)
  })

  it('should allow counting spam events if include:spam is provided', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      const ws = createWs()
      // Broad filter with include:spam
      const filters = [{ kinds: [1], search: 'include:spam' }]
      const message = ['COUNT', 'sub_spam', ...filters]

      const handler = new CountHandler({ wss: {}, ws, nostrMessage: message })
      await handler.run()

      const payload = JSON.parse(ws.send.mock.calls[0].arguments[0])
      // Should find all 3 events (including the one with popularity 999)
      assert.equal(payload[2].count, 3)
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })
})
