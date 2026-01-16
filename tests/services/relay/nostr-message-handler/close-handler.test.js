import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

// Mock Rate Limiter
const disconnectWhenInactiveMock = mock.fn()
mock.module('#services/rate-limiting/web-socket-request-limiter.js', {
  namedExports: {
    disconnectWhenInactive: disconnectWhenInactiveMock
  }
})

// Import SUT dynamically
const { default: CloseHandler } = await import('#services/relay/nostr-message-handler/close-handler.js')

describe('CloseHandler', () => {
  afterEach(() => {
    mock.reset()
    disconnectWhenInactiveMock.mock.resetCalls()
  })

  const createWs = () => ({
    nostr: {
      subscriptions: {
        sub1: { filter: {} },
        sub2: { filter: {} }
      }
    },
    send: mock.fn(),
    close: mock.fn(),
    ip: '127.0.0.1'
  })

  it('should remove subscription on CLOSE', async () => {
    const ws = createWs()
    const message = ['CLOSE', 'sub1']

    await CloseHandler.run({ ws, nostrMessage: message })

    assert.equal(ws.nostr.subscriptions['sub1'], undefined)
    assert.ok(ws.nostr.subscriptions['sub2'])

    // Subscriptions not empty, should not call disconnectWhenInactive
    assert.equal(disconnectWhenInactiveMock.mock.calls.length, 0)
  })

  it('should call disconnectWhenInactive when last subscription is closed', async () => {
    const ws = createWs()
    // leave only sub1
    ws.nostr.subscriptions = { sub1: { filter: {} } }
    const message = ['CLOSE', 'sub1']

    await CloseHandler.run({ ws, nostrMessage: message })

    assert.equal(ws.nostr.subscriptions['sub1'], undefined)
    assert.equal(Object.keys(ws.nostr.subscriptions).length, 0)

    // Should call disconnectWhenInactive
    assert.equal(disconnectWhenInactiveMock.mock.calls.length, 1)
    assert.equal(disconnectWhenInactiveMock.mock.calls[0].arguments[0], ws)
  })

  it('should handle non-existent subscription gracefully', async () => {
    const ws = createWs()
    const message = ['CLOSE', 'sub-non-existent']

    await CloseHandler.run({ ws, nostrMessage: message })

    assert.ok(ws.nostr.subscriptions['sub1'])
    assert.ok(ws.nostr.subscriptions['sub2'])
  })
})
