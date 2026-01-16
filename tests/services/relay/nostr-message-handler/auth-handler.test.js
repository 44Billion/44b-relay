import { describe, it, before, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

// 1. Mock Rate Limiter
mock.module('#services/rate-limiting/web-socket-request-limiter.js', {
  namedExports: {
    rateLimitReqByPubkey: mock.fn(() => ({ isRateLimited: false })),
    disconnectWhenInactive: mock.fn()
  }
})

// 2. Mock Validator
mock.module('#services/event/validator.js', {
  defaultExport: {
    run: async ({ event, clientMessage }) => {
      if (clientMessage === 'AUTH' && event.kind !== 22242) {
        return { isSuccess: false, message: 'invalid: wrong event kind' }
      }
      return { isSuccess: true, message: '' }
    }
  }
})

// Import System Under Test (SUT) dynamically after mocks
const { default: AuthHandler } = await import('#services/relay/nostr-message-handler/auth-handler.js')

describe('AuthHandler', () => {
  before(() => {
    process.env.RELAY_HOST = 'test.relay.com'
  })

  afterEach(() => {
    mock.reset()
  })

  const createWs = () => ({
    nostr: { challenge: 'test-challenge', subscriptions: {} },
    send: mock.fn(),
    close: mock.fn(),
    ip: '127.0.0.1'
  })

  it('should authenticate successfully with valid challenge and relay tag', async () => {
    const ws = createWs()
    const event = {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['challenge', 'test-challenge'],
        ['relay', 'ws://test.relay.com']
      ],
      pubkey: 'pubkey123',
      id: 'event1'
    }

    const handler = new AuthHandler({ ws, nostrMessage: ['AUTH', event] })
    await handler.run()

    // Should set pubkey on ws
    assert.equal(ws.nostr.pubkey, 'pubkey123')

    // Should send OK message
    assert.equal(ws.send.mock.calls.length, 1)
    const msg = JSON.parse(ws.send.mock.calls[0].arguments[0])
    assert.deepEqual(msg, ['OK', 'event1', true, ''])
  })

  it('should fail authentication if challenge is wrong', async () => {
    const ws = createWs()
    const event = {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['challenge', 'WRONG-CHALLENGE'],
        ['relay', 'ws://test.relay.com']
      ],
      pubkey: 'pubkey123',
      id: 'event2'
    }

    const handler = new AuthHandler({ ws, nostrMessage: ['AUTH', event] })
    await handler.run()

    assert.equal(ws.nostr.pubkey, undefined)
    const msg = JSON.parse(ws.send.mock.calls[0].arguments[0])
    assert.deepEqual(msg, ['OK', 'event2', false, "restricted: couldn't authenticate"])
  })

  it('should fail authentication if relay URL is wrong', async () => {
    const ws = createWs()
    const event = {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['challenge', 'test-challenge'],
        ['relay', 'ws://wrong.relay.com']
      ],
      pubkey: 'pubkey123',
      id: 'event3'
    }

    const handler = new AuthHandler({ ws, nostrMessage: ['AUTH', event] })
    await handler.run()

    assert.equal(ws.nostr.pubkey, undefined)
    const msg = JSON.parse(ws.send.mock.calls[0].arguments[0])
    assert.deepEqual(msg, ['OK', 'event3', false, "restricted: couldn't authenticate"])
  })

  it('should fail authentication if event kind is not 22242', async () => {
    const ws = createWs()
    const event = {
      kind: 1, // wrong kind
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['challenge', 'test-challenge'],
        ['relay', 'ws://test.relay.com']
      ],
      pubkey: 'pubkey123',
      id: 'event4'
    }

    const handler = new AuthHandler({ ws, nostrMessage: ['AUTH', event] })
    await handler.run()

    assert.equal(ws.nostr.pubkey, undefined)
    const msg = JSON.parse(ws.send.mock.calls[0].arguments[0])
    assert.deepEqual(msg, ['OK', 'event4', false, 'invalid: wrong event kind'])
  })
})
