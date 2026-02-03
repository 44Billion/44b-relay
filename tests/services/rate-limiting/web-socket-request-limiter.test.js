import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as limiter from '#services/rate-limiting/web-socket-request-limiter.js'

describe('WebSocket Request Limiter', () => {
  before(() => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  })

  after(() => {
    mock.timers.reset()
  })

  describe('rateLimitReqByIp', () => {
    it('should limit open connections per IP', () => {
      const ip = '192.168.1.50'
      const req = { ip, headers: {}, socket: { remoteAddress: ip } }

      // Burst 3 requests.
      for (let i = 0; i < 3; i++) {
        const res = limiter.rateLimitReqByIp(req)
        assert.equal(res.isRateLimited, false)
      }
      // 4th request limited by 3/1s
      const res = limiter.rateLimitReqByIp(req)
      assert.equal(res.isRateLimited, true)

      mock.timers.tick(1100)

      // Can do more now.
      for (let i = 0; i < 3; i++) {
        const r = limiter.rateLimitReqByIp(req)
        assert.equal(r.isRateLimited, false)
      }
    })

    it('should return request to pool and allow more connections', () => {
      const ip = '192.168.1.51'
      const req = { ip, headers: {}, socket: { remoteAddress: ip } }

      // Fill up the pool (MAX_OPEN_CONNECTIONS = 30)
      for (let i = 0; i < 30; i++) {
        const res = limiter.rateLimitReqByIp(req)
        // Tick time to avoid burst limits (3/1s and 10/5s)
        mock.timers.tick(1100)
        assert.equal(res.isRateLimited, false, `Failed at ${i}`)
      }

      const capped = limiter.rateLimitReqByIp(req)
      assert.equal(capped.isRateLimited, true, 'Should be capped at 30')

      limiter.returnReqToIpRateLimitPool(req)
      const afterReturn = limiter.rateLimitReqByIp(req)
      assert.equal(afterReturn.isRateLimited, false, 'Should allow one more after return')
    })
  })

  describe('rateLimitReqByPubkey', () => {
    it('should limit open connections per pubkey', () => {
      const pubkey = 'ws_pubkey_limit'
      const ws = { nostr: { pubkey } }

      // MAX_OPEN_CONNECTIONS_PER_PUBKEY = 15

      for (let i = 0; i < 15; i++) {
        const res = limiter.rateLimitReqByPubkey(ws)
        assert.equal(res.isRateLimited, false, `Conn ${i} failed`)
      }

      const res = limiter.rateLimitReqByPubkey(ws)
      assert.equal(res.isRateLimited, true)
    })

    it('should return request to pubkey pool and allow more connections', () => {
      const pubkey = 'ws_pubkey_return'
      const ws = { nostr: { pubkey } }

      for (let i = 0; i < 15; i++) {
        limiter.rateLimitReqByPubkey(ws)
      }

      assert.equal(limiter.rateLimitReqByPubkey(ws).isRateLimited, true)

      limiter.returnReqToPubkeyRateLimitPool(ws)
      assert.equal(limiter.rateLimitReqByPubkey(ws).isRateLimited, false)
    })

    it('should handle missing pubkey when returning to pool', () => {
      const ws = { nostr: {} }
      // Should not throw
      limiter.returnReqToPubkeyRateLimitPool(ws)
    })
  })

  describe('disconnectIfNotAuthenticatedAfterSomeTime', () => {
    it('should disconnect if not authenticated after 5 seconds', () => {
      const ws = {
        nostr: {},
        close: mock.fn()
      }

      limiter.disconnectIfNotAuthenticatedAfterSomeTime(ws)

      mock.timers.tick(4999)
      assert.equal(ws.close.mock.callCount(), 0)

      mock.timers.tick(1)
      assert.equal(ws.close.mock.callCount(), 1)
      assert.deepEqual(ws.close.mock.calls[0].arguments, [1000, "Didn't authenticate in time"])
    })

    it('should NOT disconnect if already authenticated', () => {
      const ws = {
        nostr: { pubkey: 'someone' },
        close: mock.fn()
      }

      limiter.disconnectIfNotAuthenticatedAfterSomeTime(ws)

      mock.timers.tick(5000)
      assert.equal(ws.close.mock.callCount(), 0)
    })
  })

  describe('disconnectWhenInactive', () => {
    it('should disconnect if inactive for 3 minutes', () => {
      const ws = {
        nostr: { subscriptions: {} },
        close: mock.fn()
      }

      limiter.disconnectWhenInactive(ws)

      mock.timers.tick(1000 * 60 * 3 - 1)
      assert.equal(ws.close.mock.callCount(), 0)

      mock.timers.tick(1)
      assert.equal(ws.close.mock.callCount(), 1)
      assert.deepEqual(ws.close.mock.calls[0].arguments, [1013, 'Casting off client due to inactivity'])
    })

    it('should NOT disconnect if has active subscriptions', () => {
      const ws = {
        nostr: { subscriptions: { sub1: {} } },
        close: mock.fn()
      }

      limiter.disconnectWhenInactive(ws)

      mock.timers.tick(1000 * 60 * 3)
      assert.equal(ws.close.mock.callCount(), 0)
    })

    it('should reschedule if activity updated', () => {
      const ws = {
        nostr: { subscriptions: {} },
        close: mock.fn()
      }

      limiter.disconnectWhenInactive(ws)

      mock.timers.tick(1000 * 60 * 2) // 2 minutes pass
      ws.nostr.lastActiveAtMs = Date.now() // activity now

      mock.timers.tick(1000 * 60 * 1) // 1 minute pass (total 3 from start)
      assert.equal(ws.close.mock.callCount(), 0, 'Should not close yet because it was rescheduled')

      mock.timers.tick(1000 * 60 * 3) // another 3 minutes pass (from the moment first timeout fired)
      assert.equal(ws.close.mock.callCount(), 1, 'Should close after 3 minutes from rescheduling')
    })

    it('should cleanup timeout reference when active subscriptions exist', () => {
      const ws = {
        nostr: { subscriptions: { sub1: {} } },
        close: mock.fn()
      }

      limiter.disconnectWhenInactive(ws)

      mock.timers.tick(1000 * 60 * 3)

      assert.equal(ws.close.mock.callCount(), 0)
      assert.equal(ws.nostr.inactivityTimeout, undefined, 'Should have deleted timeout reference')
    })
  })
})
