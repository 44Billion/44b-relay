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
// We mock validator to always say success generally, to isolate handler logic
mock.module('#services/event/validator.js', {
  defaultExport: {
    run: mock.fn(async () => ({ isSuccess: true, message: '' }))
  }
})

// 3. Mock Authenticator
mock.module('#services/relay/authenticator.js', {
  namedExports: {
    isAuthenticated: mock.fn((ctx) => !!ctx.ws.nostr.pubkey),
    authenticate: mock.fn(async () => ({ isSuccess: true, message: '' }))
  }
})

// 4. Mock Event Saver
mock.module('#services/event/saver/mdb/index.js', {
  defaultExport: {
    run: mock.fn(async () => ({ isSuccess: true, isDuplicate: false, message: '' }))
  }
})

// 5. Mock MDB Maintainer (Popularity)
mock.module('#services/event/maintainer/mdb/index.js', {
  namedExports: {
    loadPopularityFilters: mock.fn(async () => {}),
    getPopularityLevel: mock.fn(() => 10)
  }
})

// 6. Mock IP Tracker
mock.module('#services/event/tracker/mdb/ip-activity.js', {
  namedExports: {
    trackIpActivity: mock.fn()
  }
})

// Import SUT
// Note: We need to import AFTER mocks
const { default: EventHandler } = await import('#services/relay/nostr-message-handler/event-handler.js')
const { default: EventSaver } = await import('#services/event/saver/mdb/index.js')
const { getPopularityLevel } = await import('#services/event/maintainer/mdb/index.js')

describe('EventHandler', () => {
  before(() => {
    process.env.RELAY_HOST = 'test.relay.com'
  })

  afterEach(() => {
    mock.reset()
    EventSaver.run.mock.resetCalls()
  })

  const createWs = (id) => ({
    nostr: { subscriptions: {}, pubkey: undefined, challenge: 'challenge' },
    send: mock.fn(),
    close: mock.fn(),
    ip: '127.0.0.1',
    readyState: 1, // OPEN
    id // arbitrary id for test tracking
  })

  it('should process and relay valid event to matching subscription', async () => {
    // Setup Success Mock for Saver
    EventSaver.run.mock.mockImplementation(async () => ({ isSuccess: true, isDuplicate: false, message: '' }))
    // Setup Popularity to allow broadcasting ( <= 6 )
    getPopularityLevel.mock.mockImplementation(() => 1)

    const wsSender = createWs('sender')
    const wsReceiver = createWs('receiver')

    // Receiver wants kind 1
    wsReceiver.nostr.subscriptions['sub1'] = {
      filters: [{ kinds: [1], isBroad: true }]
    }

    const wss = {
      clients: [wsSender, wsReceiver]
    }

    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event1',
      content: 'hello'
    }

    const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
    await handler.run()

    // 1. Should acknowledge OK to sender
    assert.equal(wsSender.send.mock.calls.length, 1)
    const ackMsg = JSON.parse(wsSender.send.mock.calls[0].arguments[0])
    assert.deepEqual(ackMsg, ['OK', 'event1', true, ''])

    // 2. Should call EventSaver
    assert.equal(EventSaver.run.mock.calls.length, 1)

    // 3. Should relay to receiver
    assert.equal(wsReceiver.send.mock.calls.length, 1)
    const relayMsg = JSON.parse(wsReceiver.send.mock.calls[0].arguments[0])
    assert.equal(relayMsg[0], 'EVENT')
    assert.equal(relayMsg[1], 'sub1')
    assert.deepEqual(relayMsg[2], event)
  })

  it('should NOT relay if event is expired', async () => {
    EventSaver.run.mock.mockImplementation(async () => ({ isSuccess: true, isDuplicate: false, message: '' }))

    const wsSender = createWs('sender')
    const wsReceiver = createWs('receiver')
    wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ kinds: [1] }] }
    const wss = { clients: [wsSender, wsReceiver] }

    const expiredEvent = {
      kind: 1,
      // expired 1 hour ago
      created_at: Math.floor(Date.now() / 1000) - 10,
      tags: [['expiration', (Math.floor(Date.now() / 1000) - 3600).toString()]],
      pubkey: 'pubkey1',
      id: 'event_expired',
      content: 'expired'
    }

    const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', expiredEvent] })
    await handler.run()

    // Assert OK message says expired (shouldRelay: false)
    assert.equal(wsSender.send.mock.calls.length, 1)
    const ackMsg = JSON.parse(wsSender.send.mock.calls[0].arguments[0])

    assert.equal(ackMsg[0], 'OK')
    assert.equal(ackMsg[1], 'event_expired')
    assert.equal(ackMsg[2], true)
    assert.match(ackMsg[3], /expired/)

    // Assert NOT relayed
    assert.equal(wsReceiver.send.mock.calls.length, 0)

    // Assert NOT called EventSaver
    assert.equal(EventSaver.run.mock.calls.length, 0)
  })

  // it('should NOT relay if restricted reaction', async () => {
  //   const wsSender = createWs('sender')
  //   const wsReceiver = createWs('receiver')
  //   wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ kinds: [7] }] }
  //   const wss = { clients: [wsSender, wsReceiver] }

  //   const invalidReaction = {
  //     kind: 7,
  //     created_at: Math.floor(Date.now() / 1000),
  //     tags: [],
  //     pubkey: 'pubkey1',
  //     id: 'event_bad_reaction',
  //     content: 'not a plus or minus'
  //   }

  //   const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', invalidReaction] })
  //   await handler.run()

  //   // OK message should be false
  //   assert.equal(wsSender.send.mock.calls.length, 1)
  //   const ackMsg = JSON.parse(wsSender.send.mock.calls[0].arguments[0])
  //   assert.equal(ackMsg[0], 'OK')
  //   assert.equal(ackMsg[1], 'event_bad_reaction')
  //   assert.equal(ackMsg[2], false)
  //   assert.match(ackMsg[3], /invalid/)

  //   assert.equal(wsReceiver.send.mock.calls.length, 0)
  // })

  it('should NOT relay to broad filter if author popularity is high', async () => {
    // Ensure we are NOT in integration test mode to trigger popularity check
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 999) // High popularity (spammy)

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      // Receiver has broad filter
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ isBroad: true }] }
      const wss = { clients: [wsSender, wsReceiver] }

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'spam_pubkey',
        id: 'event_spam',
        content: 'spam'
      }

      const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
      await handler.run()

      // OK message should be true (persisted), but NOT relayed
      const ackMsg = JSON.parse(wsSender.send.mock.calls[0].arguments[0])
      assert.equal(ackMsg[2], true)

      assert.equal(wsReceiver.send.mock.calls.length, 0)
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should relay to broad filter if author popularity is high but includeSpam is set', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 999)

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      // Receiver has broad filter WITH includeSpam
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ isBroad: true, includeSpam: true }] }
      const wss = { clients: [wsSender, wsReceiver] }

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'spam_pubkey',
        id: 'event_spam_allowed',
        content: 'spam with explicit include'
      }

      const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
      await handler.run()

      // Should be relayed
      assert.equal(wsReceiver.send.mock.calls.length, 1)
      const relayMsg = JSON.parse(wsReceiver.send.mock.calls[0].arguments[0])
      assert.equal(relayMsg[1], 'sub1')
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should relay to broad filter with isSpam only if author popularity is high', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 999)

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      // Receiver has broad filter WITH isSpam
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ isBroad: true, isSpam: true }] }
      const wss = { clients: [wsSender, wsReceiver] }

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'spam_pubkey',
        id: 'event_is_spam',
        content: 'only spam please'
      }

      const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
      await handler.run()

      // Should be relayed because author popularity > 6
      assert.equal(wsReceiver.send.mock.calls.length, 1)
      const relayMsg = JSON.parse(wsReceiver.send.mock.calls[0].arguments[0])
      assert.equal(relayMsg[1], 'sub1')
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should NOT relay to broad filter with isSpam if author popularity is low', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 3)

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      // Receiver has broad filter WITH isSpam
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ isBroad: true, isSpam: true }] }
      const wss = { clients: [wsSender, wsReceiver] }

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'nonspam_pubkey',
        id: 'event_not_spam',
        content: 'not spam'
      }

      const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
      await handler.run()

      // Should NOT be relayed because author popularity <= 6
      assert.equal(wsReceiver.send.mock.calls.length, 0)
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should NOT relay future event to others', async () => {
    const wsSender = createWs('sender')
    wsSender.nostr.pubkey = 'sender_pubkey'
    const wsReceiver = createWs('receiver')
    wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ kinds: [1] }] }
    const wss = { clients: [wsSender, wsReceiver] }

    const futureEvent = {
      kind: 1,
      // 1 hour in the future
      created_at: Math.floor(Date.now() / 1000) + 3600,
      tags: [],
      pubkey: 'sender_pubkey',
      id: 'event_future',
      content: 'future'
    }

    const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', futureEvent] })
    await handler.run()

    // OK message should be true (persisted)
    const ackMsg = JSON.parse(wsSender.send.mock.calls[0].arguments[0])
    assert.equal(ackMsg[2], true)

    // Should NOT be relayed to receiver
    assert.equal(wsReceiver.send.mock.calls.length, 0)
  })
})
