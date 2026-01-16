import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as limiter from '#services/rate-limiting/nostr-message-limiter.js'
import { eventKinds } from '#constants/event.js'

describe('Nostr Message Limiter', () => {
  before(() => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  })

  after(() => {
    mock.timers.reset()
  })

  describe('rateLimitNostrMessageByPubkey', () => {
    it('should limit based on pubkey', () => {
      const pubkey = 'pubkey1'
      const ws = { ip: '1.2.3.4', nostr: { pubkey } }

      // Limit is 12 per 2 seconds
      for (let i = 0; i < 12; i++) {
        const { isRateLimited } = limiter.rateLimitNostrMessageByPubkey(ws)
        assert.equal(isRateLimited, false, `Request ${i + 1} should not be limited`)
      }

      const { isRateLimited } = limiter.rateLimitNostrMessageByPubkey(ws)
      assert.equal(isRateLimited, true, 'Request 13 should be limited')
    })

    it('should limit based on ip if pubkey is missing', () => {
      const ip = '1.2.3.5'
      const ws = { ip, nostr: {} }

      // Limit is 12 per 2 seconds
      for (let i = 0; i < 12; i++) {
        const { isRateLimited } = limiter.rateLimitNostrMessageByPubkey(ws)
        assert.equal(isRateLimited, false, `Request ${i + 1} should not be limited`)
      }

      const { isRateLimited } = limiter.rateLimitNostrMessageByPubkey(ws)
      assert.equal(isRateLimited, true, 'Request 13 should be limited')
    })
  })

  describe('rateLimitNostrAuthMessageByPubkey', () => {
    it('should limit auth messages', () => {
      const pubkey = 'auth_pubkey'
      const ws = { ip: '1.1.1.1', nostr: { pubkey } }

      // Limit b: 2 per 1 second
      // Global auth limit is 20 per minute.

      // Request 1
      let res = limiter.rateLimitNostrAuthMessageByPubkey(ws)
      assert.equal(res.isRateLimited, false)

      // Request 2
      res = limiter.rateLimitNostrAuthMessageByPubkey(ws)
      assert.equal(res.isRateLimited, false)

      // Request 3 (should hit burst limit)
      res = limiter.rateLimitNostrAuthMessageByPubkey(ws)
      assert.equal(res.isRateLimited, true)

      // Advance time by 1.1 second
      mock.timers.tick(1100)

      // Request 4 (burst window reset)
      res = limiter.rateLimitNostrAuthMessageByPubkey(ws)
      assert.equal(res.isRateLimited, false)
    })
  })

  describe('rateLimitNostrReqMessageByWsConnection', () => {
    it('should limit subscriptions per connection', () => {
      const ws = {
        nostr: {
          subscriptions: {}
        }
      }
      const limit = 10 // MAX_SUBSCRIPTIONS_PER_WS_CONNECTION

      for (let i = 0; i < limit; i++) {
        ws.nostr.subscriptions[`sub${i}`] = { filters: [] }
      }

      // New subscription
      let res = limiter.rateLimitNostrReqMessageByWsConnection(ws, 'newSub')
      assert.equal(res.isRateLimited, true)

      // Existing subscription (replace)
      res = limiter.rateLimitNostrReqMessageByWsConnection(ws, 'sub0')
      assert.equal(res.isRateLimited, false)
    })
  })

  describe('rateLimitNostrReqMessageByPubkey', () => {
    it('should limit subscriptions globally per pubkey', () => {
      const pubkey = 'pubkey_global_limit'
      // Populate 10 subs.
      // MAX_SUBSCRIPTIONS_PER_PUBKEY = 10 (same as per connection)
      const clients = new Set()
      const wsFull = { nostr: { pubkey, subscriptions: {} } }
      for (let i = 0; i < 10; i++) wsFull.nostr.subscriptions[`full_${i}`] = { filters: [{}] }
      clients.add(wsFull)
      const wss = { clients }

      let res = limiter.rateLimitNostrReqMessageByPubkey(wss, wsFull, 'newSub', [{}])
      assert.equal(res.isRateLimited, true)

      // Test Replace
      res = limiter.rateLimitNostrReqMessageByPubkey(wss, wsFull, 'full_0', [{}])
      // 10 filters total. Replacing 1 filter with 1 filter -> Total 10.
      // Limit is 10. if >= 10, isRateLimited = true.
      assert.equal(res.isRateLimited, true)
    })
  })

  describe('rateLimitNostrEventMessageByPubkey', () => {
    it('should limit metadata events', () => {
      const pubkey = 'meta_pub'
      const ws = { nostr: { pubkey } }
      const event = { kind: eventKinds.METADATA }

      // Limit 7 per 1 min
      for (let i = 0; i < 7; i++) {
        const res = limiter.rateLimitNostrEventMessageByPubkey(ws, event)
        assert.equal(res.isRateLimited, false)
      }
      const res = limiter.rateLimitNostrEventMessageByPubkey(ws, event)
      assert.equal(res.isRateLimited, true)
    })

    it('should limit text note events', () => {
      const pubkey = 'note_pub'
      const ws = { nostr: { pubkey } }
      const event = { kind: eventKinds.TEXT_NOTE }

      // Limit b: 1 per 5 seconds (burst)

      // 1st request - ok
      let res = limiter.rateLimitNostrEventMessageByPubkey(ws, event)
      assert.equal(res.isRateLimited, false)

      // 2nd request immediately - fail burst
      res = limiter.rateLimitNostrEventMessageByPubkey(ws, event)
      assert.equal(res.isRateLimited, true)

      // Advance 5.1s
      mock.timers.tick(5100)

      // 3rd request - ok
      res = limiter.rateLimitNostrEventMessageByPubkey(ws, event)
      assert.equal(res.isRateLimited, false)
    })
  })
})
