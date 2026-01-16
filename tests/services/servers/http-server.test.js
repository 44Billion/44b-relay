import { describe, it, mock, beforeEach, before, after } from 'node:test'
import assert from 'node:assert/strict'

// Mock dependencies
const getIpMock = mock.fn(() => '127.0.0.1')
mock.module('#helpers/request.js', {
  namedExports: {
    getIp: getIpMock
  }
})

const rateLimitReqByIpMock = mock.fn(() => ({ isRateLimited: false }))
mock.module('#services/rate-limiting/server-request-limiter.js', {
  namedExports: {
    rateLimitReqByIp: rateLimitReqByIpMock
  }
})

let handleRequest
let server
describe('HTTP Server handleRequest', () => {
  before(async () => {
    // Force shouldSpinUpServer to true for testing responses
    process.env.SHOULD_SPIN_UP_SERVER = 'true'
    const module = await import('#services/servers/http-server.js')
    handleRequest = module.handleRequest
    server = module.default
  })

  after(() => {
    if (server && typeof server.close === 'function') {
      server.close()
    }
  })

  beforeEach(() => {
    getIpMock.mock.resetCalls()
    rateLimitReqByIpMock.mock.resetCalls()
  })

  it('should return 429 when rate limited', () => {
    const req = { url: '/', headers: {}, socket: {} }
    const res = {
      setHeader: mock.fn(),
      writeHead: mock.fn(),
      end: mock.fn()
    }

    const nextWindow = new Date(Date.now() + 5000)
    rateLimitReqByIpMock.mock.mockImplementationOnce(() => ({
      isRateLimited: true,
      nextWindow
    }))

    handleRequest(req, res)

    assert.equal(res.writeHead.mock.calls[0].arguments[0], 429)
    assert.ok(res.setHeader.mock.calls.some(call => call.arguments[0] === 'retry-after'))
    const body = JSON.parse(res.end.mock.calls[0].arguments[0])
    assert.deepEqual(body, { errors: { base: ['Too Many Requests'] } })
  })

  it('should return Relay Information Document for NIP-11 request', () => {
    const req = {
      method: 'GET',
      url: '/',
      headers: { accept: 'application/nostr+json' },
      socket: {}
    }
    const res = {
      setHeader: mock.fn(),
      writeHead: mock.fn(),
      end: mock.fn()
    }

    handleRequest(req, res)

    assert.equal(res.writeHead.mock.calls[0].arguments[0], 200)
    assert.ok(res.setHeader.mock.calls.some(call =>
      call.arguments[0] === 'content-type' && call.arguments[1] === 'application/nostr+json'
    ))
    const body = JSON.parse(res.end.mock.calls[0].arguments[0])
    assert.equal(body.name, '44billion.net Relay')
    assert.ok(Array.isArray(body.supported_nips))
  })

  it('should return error message for standard browser request to /', () => {
    const req = {
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' },
      socket: {}
    }
    const res = {
      setHeader: mock.fn(),
      writeHead: mock.fn(),
      end: mock.fn()
    }

    handleRequest(req, res)

    assert.ok(res.setHeader.mock.calls.some(call =>
      call.arguments[0] === 'content-type' && call.arguments[1] === 'application/json'
    ))
    assert.ok(res.end.mock.callCount() > 0)
  })

  it('should return 404 for non-GET request to /', () => {
    const req = {
      method: 'POST',
      url: '/',
      headers: {},
      socket: {}
    }
    const res = {
      setHeader: mock.fn(),
      writeHead: mock.fn(),
      end: mock.fn()
    }

    handleRequest(req, res)

    assert.equal(res.writeHead.mock.calls[0].arguments[0], 404)
    const body = JSON.parse(res.end.mock.calls[0].arguments[0])
    assert.equal(body.error.base[0], 'Resource not found')
  })

  it('should return 404 for unknown route', () => {
    const req = {
      method: 'GET',
      url: '/unknown',
      headers: {},
      socket: {}
    }
    const res = {
      setHeader: mock.fn(),
      writeHead: mock.fn(),
      end: mock.fn()
    }

    handleRequest(req, res)

    assert.equal(res.writeHead.mock.calls[0].arguments[0], 404)
  })

  it('should return 500 on error', () => {
    const req = {
      url: '/',
      headers: {},
      socket: {}
    }
    const res = {
      setHeader: mock.fn(),
      writeHead: mock.fn(),
      end: mock.fn()
    }

    // Trigger an error by making getIp throw
    getIpMock.mock.mockImplementationOnce(() => { throw new Error('Test Error') })

    handleRequest(req, res)

    assert.equal(res.writeHead.mock.calls[0].arguments[0], 500)
    assert.ok(res.end.mock.calls[0].arguments[0] instanceof Error)
  })
})
