import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { rateLimitReqByIp } from '#services/rate-limiting/server-request-limiter.js'

describe('Server Request Limiter', () => {
  before(() => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  })

  after(() => {
    mock.timers.reset()
  })

  it('should rate limit requests by IP', () => {
    const ip = '10.0.0.1'
    const req = {
      ip,
      headers: {},
      socket: { remoteAddress: ip }
    }

    // Limit: 12 per 2 seconds
    for (let i = 0; i < 12; i++) {
      const { isRateLimited } = rateLimitReqByIp(req)
      assert.equal(isRateLimited, false, `Request ${i} should not be limited`)
    }

    const { isRateLimited } = rateLimitReqByIp(req)
    assert.equal(isRateLimited, true, 'Request 13 should be limited')

    // Advance 2s
    mock.timers.tick(2001)

    const res = rateLimitReqByIp(req)
    assert.equal(res.isRateLimited, false, 'Should operate after window reset')
  })

  it('should extract IP from x-forwarded-for', () => {
    const ip = '10.0.0.2'
    const req = {
      headers: { 'x-forwarded-for': `${ip}, 127.0.0.1` }
    }

    // Consume 1 request to cache the IP on req object (getIp modifies req.ip)
    rateLimitReqByIp(req)
    assert.equal(req.ip, ip)
  })
})
