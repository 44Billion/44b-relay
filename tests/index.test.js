import { describe, it, mock, beforeEach, before } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// Mock dependencies
const getIpMock = mock.fn(() => '127.0.0.1')
mock.module('#helpers/request.js', {
  namedExports: {
    getIp: getIpMock
  }
})

const serverMock = new EventEmitter()
mock.module('#services/servers/http-server.js', {
  defaultExport: serverMock
})

const wssMock = new EventEmitter()
wssMock.handleUpgrade = mock.fn((req, socket, head, cb) => {
  const ws = new EventEmitter()
  cb(ws)
})
mock.module('#services/servers/web-socket-server.js', {
  defaultExport: wssMock
})

const handleConnectionMock = mock.fn()
class MockRelay {
  constructor (args) {
    this.args = args
    this.handleConnection = handleConnectionMock
  }
}
mock.module('#services/relay/index.js', {
  defaultExport: MockRelay
})

const wsLimiterMocks = {
  rateLimitReqByIp: mock.fn(() => ({ isRateLimited: false })),
  returnReqToIpRateLimitPool: mock.fn(),
  returnReqToPubkeyRateLimitPool: mock.fn()
  // disconnectIfNotAuthenticatedAfterSomeTime: mock.fn()
}
mock.module('#services/rate-limiting/web-socket-request-limiter.js', {
  namedExports: wsLimiterMocks
})

const serverLimiterMocks = {
  rateLimitReqByIp: mock.fn(() => ({ isRateLimited: false }))
}
mock.module('#services/rate-limiting/server-request-limiter.js', {
  namedExports: serverLimiterMocks
})

let indexModule
describe('Main Entry Point (index.js)', () => {
  before(async () => {
    process.env.SHOULD_SPIN_UP_SERVER = 'true'
    indexModule = await import('../index.js')
  })

  beforeEach(() => {
    mock.restoreAll()
    getIpMock.mock.resetCalls()
    wssMock.handleUpgrade.mock.resetCalls()
    handleConnectionMock.mock.resetCalls()
    Object.values(wsLimiterMocks).forEach(m => m.mock.resetCalls())
    Object.values(serverLimiterMocks).forEach(m => m.mock.resetCalls())
  })

  describe('handleHttpServerUpgrade', () => {
    it('should reject non-websocket upgrade requests', () => {
      const req = {
        headers: { upgrade: 'not-websocket' },
        method: 'GET',
        url: '/',
        socket: {},
        on: mock.fn()
      }
      const socket = { end: mock.fn(), on: mock.fn() }

      indexModule.handleHttpServerUpgrade(req, socket, Buffer.from(''))

      assert.equal(socket.end.mock.callCount(), 1)
      assert.match(socket.end.mock.calls[0].arguments[0], /503 Service Unavailable/)
    })

    it('should handle rate limiting at server level', () => {
      const req = {
        headers: { upgrade: 'websocket' },
        method: 'GET',
        url: '/',
        socket: {},
        on: mock.fn()
      }
      const socket = { end: mock.fn(), on: mock.fn() }

      serverLimiterMocks.rateLimitReqByIp.mock.mockImplementationOnce(() => ({ isRateLimited: true }))

      indexModule.handleHttpServerUpgrade(req, socket, Buffer.from(''))

      assert.equal(socket.end.mock.callCount(), 1)
      assert.match(socket.end.mock.calls[0].arguments[0], /429 Too Many Requests/)
    })

    it('should handle rate limiting at websocket level', () => {
      const req = {
        headers: { upgrade: 'websocket' },
        method: 'GET',
        url: '/',
        socket: {},
        on: mock.fn()
      }
      const socket = { end: mock.fn(), on: mock.fn() }

      wsLimiterMocks.rateLimitReqByIp.mock.mockImplementationOnce(() => ({ isRateLimited: true }))

      indexModule.handleHttpServerUpgrade(req, socket, Buffer.from(''))

      assert.equal(socket.end.mock.callCount(), 1)
      assert.match(socket.end.mock.calls[0].arguments[0], /429 Too Many Requests/)
    })

    it('should proceed with upgrade if not rate limited', () => {
      const req = {
        headers: { upgrade: 'websocket' },
        method: 'GET',
        url: '/',
        socket: {},
        on: mock.fn()
      }
      const socket = { end: mock.fn(), on: mock.fn() }
      const head = Buffer.from('upgrade-head')

      indexModule.handleHttpServerUpgrade(req, socket, head)

      assert.equal(wssMock.handleUpgrade.mock.callCount(), 1)
      assert.equal(wssMock.handleUpgrade.mock.calls[0].arguments[0], req)
      assert.equal(wssMock.handleUpgrade.mock.calls[0].arguments[1], socket)
      assert.equal(wssMock.handleUpgrade.mock.calls[0].arguments[2], head)
    })
  })

  describe('handleWebSocketServerConnection', () => {
    it('should set up connection and listeners', () => {
      const ws = new EventEmitter()
      const req = { some: 'req' }

      indexModule.handleWebSocketServerConnection(ws, req)

      // assert.equal(wsLimiterMocks.disconnectIfNotAuthenticatedAfterSomeTime.mock.callCount(), 1)
      assert.equal(handleConnectionMock.mock.callCount(), 1)
      assert.equal(handleConnectionMock.mock.calls[0].arguments[0], ws)
      assert.equal(handleConnectionMock.mock.calls[0].arguments[1], req)
    })

    it('should return to pools on close', () => {
      const ws = new EventEmitter()
      const req = { some: 'req' }

      indexModule.handleWebSocketServerConnection(ws, req)

      ws.emit('close')

      assert.equal(wsLimiterMocks.returnReqToIpRateLimitPool.mock.callCount(), 1)
      assert.equal(wsLimiterMocks.returnReqToPubkeyRateLimitPool.mock.callCount(), 1)
      assert.equal(wsLimiterMocks.returnReqToIpRateLimitPool.mock.calls[0].arguments[0], req)
      assert.equal(wsLimiterMocks.returnReqToPubkeyRateLimitPool.mock.calls[0].arguments[0], ws)
    })
  })

  describe('Initialization', () => {
    it('should have attached listeners to server and wss', () => {
      // Since it's executed on import, we check if listeners were added
      assert.equal(serverMock.listenerCount('upgrade'), 1)
      assert.equal(wssMock.listenerCount('connection'), 1)
    })
  })
})
