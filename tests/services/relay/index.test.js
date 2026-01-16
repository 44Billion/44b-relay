import { describe, it, mock, beforeEach, before } from 'node:test'
import assert from 'node:assert/strict'

// Mock dependencies
const requestAuthenticationMock = mock.fn()
mock.module('#services/relay/authenticator.js', {
  namedExports: {
    requestAuthentication: requestAuthenticationMock
  }
})

const disconnectWhenInactiveMock = mock.fn()
mock.module('#services/rate-limiting/web-socket-request-limiter.js', {
  namedExports: {
    disconnectWhenInactive: disconnectWhenInactiveMock
  }
})

const mockRun = mock.fn()
class MockNostrMessageHandler {
  constructor (args) {
    this.args = args
  }

  run () {
    mockRun(this.args)
  }
}

// Relay service uses './nostr-message-handler/index.js'
mock.module('#services/relay/nostr-message-handler/index.js', {
  defaultExport: MockNostrMessageHandler
})

let Relay
describe('Relay Service', () => {
  let relay
  const wss = { clients: new Set() }

  before(async () => {
    const module = await import('#services/relay/index.js')
    Relay = module.default
  })

  beforeEach(() => {
    relay = new Relay({ wss })
    requestAuthenticationMock.mock.resetCalls()
    disconnectWhenInactiveMock.mock.resetCalls()
    mockRun.mock.resetCalls()
  })

  describe('decorateClient', () => {
    it('should initialize ws.nostr with required properties', () => {
      const ws = {}
      relay.decorateClient(ws)

      assert.ok(ws.nostr)
      assert.equal(typeof ws.nostr.challenge, 'string')
      assert.equal(ws.nostr.challenge.length > 0, true)
      assert.deepEqual(ws.nostr.subscriptions, {})
      assert.equal(typeof ws.nostr.lastActiveAtMs, 'number')
    })
  })

  describe('handleConnection', () => {
    it('should set up the client connection', () => {
      const ws = {
        on: mock.fn()
      }
      const decorateSpy = mock.method(relay, 'decorateClient')
      const attachSpy = mock.method(relay, 'attachMessageHandler')
      const authSpy = mock.method(relay, 'requestAuthentication')
      const timeoutSpy = mock.method(relay, 'setInactivityTimeout')

      relay.handleConnection(ws, {})

      assert.equal(decorateSpy.mock.callCount(), 1)
      assert.equal(attachSpy.mock.callCount(), 1)
      assert.equal(authSpy.mock.callCount(), 1)
      assert.equal(timeoutSpy.mock.callCount(), 1)
    })
  })

  describe('attachMessageHandler', () => {
    it('should add message event listener', () => {
      const ws = {
        on: mock.fn()
      }
      relay.attachMessageHandler(ws)

      assert.equal(ws.on.mock.callCount(), 1)
      assert.equal(ws.on.mock.calls[0].arguments[0], 'message')
      assert.equal(typeof ws.on.mock.calls[0].arguments[1], 'function')
    })
  })

  describe('getHandleMessage', () => {
    it('should parse valid nostr message and call handleNostrMessage', () => {
      const handleNostrSpy = mock.method(relay, 'handleNostrMessage')
      const handler = relay.getHandleMessage()
      const ws = {}
      const message = Buffer.from(JSON.stringify(['EVENT', { kind: 1 }]))

      handler.call(ws, message)

      assert.equal(handleNostrSpy.mock.callCount(), 1)
      const callArgs = handleNostrSpy.mock.calls[0].arguments[0]
      assert.equal(callArgs.ws, ws)
      assert.deepEqual(callArgs.nostrMessage.slice(0, 2), ['EVENT', { kind: 1 }])
      assert.equal(callArgs.nostrMessage.byteLength, message.byteLength)
    })

    it('should handle invalid JSON', () => {
      const handleNostrSpy = mock.method(relay, 'handleNostrMessage')
      const handler = relay.getHandleMessage()
      const ws = {}
      const message = Buffer.from('invalid json')

      // Should not throw, but call handleNostrMessage with null
      handler.call(ws, message)

      assert.equal(handleNostrSpy.mock.callCount(), 1)
      assert.equal(handleNostrSpy.mock.calls[0].arguments[0].nostrMessage, null)
    })

    it('should handle unknown nostr message types', () => {
      const handleNostrSpy = mock.method(relay, 'handleNostrMessage')
      const handler = relay.getHandleMessage()
      const ws = {}
      const message = Buffer.from(JSON.stringify(['UNKNOWN', {}]))

      handler.call(ws, message)

      assert.equal(handleNostrSpy.mock.callCount(), 1)
      assert.equal(handleNostrSpy.mock.calls[0].arguments[0].nostrMessage, null)
    })
  })

  describe('handleNostrMessage', () => {
    it('should instantiate NostrMessageHandler and run it', () => {
      const ws = { some: 'ws' }
      const nostrMessage = ['EVENT', {}]

      relay.handleNostrMessage({ ws, nostrMessage })

      assert.equal(mockRun.mock.callCount(), 1)
      const runArgs = mockRun.mock.calls[0].arguments[0]
      assert.equal(runArgs.wss, wss)
      assert.equal(runArgs.ws, ws)
      assert.equal(runArgs.nostrMessage, nostrMessage)
    })
  })

  describe('Service Wrappers', () => {
    it('requestAuthentication should call authenticator service', () => {
      const ws = { some: 'ws' }
      relay.requestAuthentication(ws)
      assert.equal(requestAuthenticationMock.mock.callCount(), 1)
      assert.deepEqual(requestAuthenticationMock.mock.calls[0].arguments[0], { ws })
    })

    it('setInactivityTimeout should call limiter service', () => {
      const ws = { some: 'ws' }
      relay.setInactivityTimeout(ws)
      assert.equal(disconnectWhenInactiveMock.mock.callCount(), 1)
      assert.equal(disconnectWhenInactiveMock.mock.calls[0].arguments[0], ws)
    })
  })
})
