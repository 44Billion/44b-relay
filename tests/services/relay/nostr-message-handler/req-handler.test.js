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
      { id: '0000000000000000000000000000000000000000000000000000000000000002', kind: 1, pubkey: '000000000000000000000000000000000000000000000000000000000000000b', created_at: 1001, content: 'World', tags: [], sig: 'sig2' }
    ]
    const records = events.map(e => ({ ...eventToRecord(e), popularityLevel: 6 }))

    await index.addDocuments(records)
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
})
