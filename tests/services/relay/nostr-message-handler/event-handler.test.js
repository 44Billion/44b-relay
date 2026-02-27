import { describe, it, before, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

// 1. Mock Rate Limiter
mock.module('#services/rate-limiting/web-socket-request-limiter.js', {
  namedExports: {
    rateLimitReqByPubkey: mock.fn(() => ({ isRateLimited: false })),
    disconnectWhenInactive: mock.fn()
  }
})

// 1b. Mock IPC Broadcaster
const broadcastMock = mock.fn()
mock.module('#services/ipc/cross-process-broadcaster.js', {
  namedExports: {
    init: mock.fn(),
    broadcast: broadcastMock
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

// 7. Mock Language Detection
mock.module('#helpers/language.js', {
  namedExports: {
    detectEventLanguage: mock.fn(() => undefined)
  }
})

// Import SUT
// Note: We need to import AFTER mocks
const { default: EventHandler, sendToClientsWithAMatchingFilter } = await import('#services/relay/nostr-message-handler/event-handler.js')
const { default: EventSaver } = await import('#services/event/saver/mdb/index.js')
const { getPopularityLevel } = await import('#services/event/maintainer/mdb/index.js')
const { detectEventLanguage } = await import('#helpers/language.js')

describe('EventHandler', () => {
  before(() => {
    process.env.RELAY_HOST = 'test.relay.com'
  })

  afterEach(() => {
    mock.reset()
    EventSaver.run.mock.resetCalls()
    broadcastMock.mock.resetCalls()
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

  it('should relay to filter with language matching event language', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 1)
      detectEventLanguage.mock.mockImplementation(() => 'pt')

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ kinds: [1], language: 'pt' }] }
      const wss = { clients: [wsSender, wsReceiver] }

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'pubkey1',
        id: 'event_lang_match',
        content: 'Olá mundo'
      }

      const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
      await handler.run()

      assert.equal(wsReceiver.send.mock.calls.length, 1)
      const relayMsg = JSON.parse(wsReceiver.send.mock.calls[0].arguments[0])
      assert.equal(relayMsg[1], 'sub1')
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should NOT relay to filter with language not matching event language', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 1)
      detectEventLanguage.mock.mockImplementation(() => 'en')

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ kinds: [1], language: 'pt' }] }
      const wss = { clients: [wsSender, wsReceiver] }

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'pubkey1',
        id: 'event_lang_mismatch',
        content: 'Hello world'
      }

      const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
      await handler.run()

      // Event is saved (OK), but NOT relayed to the receiver
      const ackMsg = JSON.parse(wsSender.send.mock.calls[0].arguments[0])
      assert.equal(ackMsg[2], true)
      assert.equal(wsReceiver.send.mock.calls.length, 0)
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should NOT relay to filter with language when event language is undefined', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 1)
      detectEventLanguage.mock.mockImplementation(() => undefined)

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ kinds: [1], language: 'en' }] }
      const wss = { clients: [wsSender, wsReceiver] }

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'pubkey1',
        id: 'event_no_lang',
        content: '🎉'
      }

      const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
      await handler.run()

      assert.equal(wsReceiver.send.mock.calls.length, 0)
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should relay when filter has no language set (regardless of event language)', async () => {
    getPopularityLevel.mock.mockImplementation(() => 1)
    detectEventLanguage.mock.mockImplementation(() => 'fr')

    const wsSender = createWs('sender')
    const wsReceiver = createWs('receiver')
    wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ kinds: [1], isBroad: true }] }
    const wss = { clients: [wsSender, wsReceiver] }

    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_no_filter_lang',
      content: 'Bonjour le monde'
    }

    const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
    await handler.run()

    assert.equal(wsReceiver.send.mock.calls.length, 1)
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

  it('should call broadcast when shouldRelay is true (non-ephemeral)', async () => {
    EventSaver.run.mock.mockImplementation(async () => ({ isSuccess: true, isDuplicate: false, message: '' }))
    getPopularityLevel.mock.mockImplementation(() => 1)
    detectEventLanguage.mock.mockImplementation(() => 'en')

    const wsSender = createWs('sender')
    const wss = { clients: [wsSender] }

    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_broadcast',
      content: 'hello'
    }

    const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
    await handler.run()

    assert.equal(broadcastMock.mock.calls.length, 1)
    const broadcastArg = broadcastMock.mock.calls[0].arguments[0]
    assert.deepEqual(broadcastArg.event, event)
    assert.equal(broadcastArg.eventLanguage, 'en')
  })

  it('should call broadcast when shouldRelay is true (ephemeral)', async () => {
    getPopularityLevel.mock.mockImplementation(() => 1)

    const wsSender = createWs('sender')
    const wss = { clients: [wsSender] }

    const ephemeralEvent = {
      kind: 20001, // ephemeral range
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_ephemeral_broadcast',
      content: 'ephemeral'
    }

    const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', ephemeralEvent] })
    await handler.run()

    assert.equal(broadcastMock.mock.calls.length, 1)
    assert.deepEqual(broadcastMock.mock.calls[0].arguments[0].event, ephemeralEvent)
  })

  it('should NOT call broadcast when shouldRelay is false (duplicate)', async () => {
    EventSaver.run.mock.mockImplementation(async () => ({ isSuccess: true, isDuplicate: true, message: 'duplicate: already have this event' }))

    const wsSender = createWs('sender')
    const wss = { clients: [wsSender] }

    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_dup',
      content: 'dup'
    }

    const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
    await handler.run()

    assert.equal(broadcastMock.mock.calls.length, 0)
  })

  it('should NOT call broadcast when shouldRelay is false (expired)', async () => {
    const wsSender = createWs('sender')
    const wss = { clients: [wsSender] }

    const expiredEvent = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000) - 10,
      tags: [['expiration', (Math.floor(Date.now() / 1000) - 3600).toString()]],
      pubkey: 'pubkey1',
      id: 'event_expired_no_broadcast',
      content: 'expired'
    }

    const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', expiredEvent] })
    await handler.run()

    assert.equal(broadcastMock.mock.calls.length, 0)
  })
})

describe('sendToClientsWithAMatchingFilter (standalone)', () => {
  afterEach(() => {
    mock.reset()
  })

  const createWs = (id) => ({
    nostr: { subscriptions: {}, pubkey: undefined, challenge: 'challenge' },
    send: mock.fn(),
    close: mock.fn(),
    ip: '127.0.0.1',
    readyState: 1, // OPEN
    id
  })

  it('should relay event to clients with matching subscription filter', async () => {
    getPopularityLevel.mock.mockImplementation(() => 1)

    const wsReceiver = createWs('receiver')
    wsReceiver.nostr.subscriptions['sub1'] = {
      filters: [{ kinds: [1], isBroad: true }]
    }
    const wss = { clients: [wsReceiver] }

    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_standalone',
      content: 'hello'
    }

    await sendToClientsWithAMatchingFilter({ wss, event, eventLanguage: undefined })

    assert.equal(wsReceiver.send.mock.calls.length, 1)
    const relayMsg = JSON.parse(wsReceiver.send.mock.calls[0].arguments[0])
    assert.equal(relayMsg[0], 'EVENT')
    assert.equal(relayMsg[1], 'sub1')
    assert.deepEqual(relayMsg[2], event)
  })

  it('should NOT relay to clients with non-matching filter', async () => {
    getPopularityLevel.mock.mockImplementation(() => 1)

    const wsReceiver = createWs('receiver')
    wsReceiver.nostr.subscriptions['sub1'] = {
      filters: [{ kinds: [7] }] // wants kind 7, event is kind 1
    }
    const wss = { clients: [wsReceiver] }

    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_no_match',
      content: 'hello'
    }

    await sendToClientsWithAMatchingFilter({ wss, event, eventLanguage: undefined })

    assert.equal(wsReceiver.send.mock.calls.length, 0)
  })

  it('should skip clients with non-OPEN readyState', async () => {
    getPopularityLevel.mock.mockImplementation(() => 1)

    const wsReceiver = createWs('receiver')
    wsReceiver.readyState = 3 // CLOSED
    wsReceiver.nostr.subscriptions['sub1'] = {
      filters: [{ kinds: [1] }]
    }
    const wss = { clients: [wsReceiver] }

    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_closed_ws',
      content: 'hello'
    }

    await sendToClientsWithAMatchingFilter({ wss, event, eventLanguage: undefined })

    assert.equal(wsReceiver.send.mock.calls.length, 0)
  })

  it('should remove fulfilled id-based filter after matching', async () => {
    getPopularityLevel.mock.mockImplementation(() => 1)

    const wsReceiver = createWs('receiver')
    wsReceiver.nostr.subscriptions['sub1'] = {
      filters: [{ ids: ['event_id_filter'] }]
    }
    const wss = { clients: [wsReceiver] }

    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_id_filter',
      content: 'hello'
    }

    await sendToClientsWithAMatchingFilter({ wss, event, eventLanguage: undefined })

    // 2 sends: EVENT relay + CLOSED (subscription completed)
    assert.equal(wsReceiver.send.mock.calls.length, 2)
    const eventMsg = JSON.parse(wsReceiver.send.mock.calls[0].arguments[0])
    assert.equal(eventMsg[0], 'EVENT')
    const closedMsg = JSON.parse(wsReceiver.send.mock.calls[1].arguments[0])
    assert.equal(closedMsg[0], 'CLOSED')
    assert.equal(closedMsg[1], 'sub1')
    // Subscription should be removed since the only id was fulfilled
    assert.equal(wsReceiver.nostr.subscriptions['sub1'], undefined)
  })

  it('should relay to multiple clients with matching filters', async () => {
    getPopularityLevel.mock.mockImplementation(() => 1)

    const ws1 = createWs('receiver1')
    ws1.nostr.subscriptions['sub1'] = { filters: [{ kinds: [1], isBroad: true }] }
    const ws2 = createWs('receiver2')
    ws2.nostr.subscriptions['sub2'] = { filters: [{ kinds: [1], isBroad: true }] }
    const wss = { clients: [ws1, ws2] }

    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_multi',
      content: 'hello'
    }

    await sendToClientsWithAMatchingFilter({ wss, event, eventLanguage: undefined })

    assert.equal(ws1.send.mock.calls.length, 1)
    assert.equal(ws2.send.mock.calls.length, 1)
  })

  it('should NOT call broadcast (no re-broadcast from IPC listener)', async () => {
    getPopularityLevel.mock.mockImplementation(() => 1)

    const wsReceiver = createWs('receiver')
    wsReceiver.nostr.subscriptions['sub1'] = {
      filters: [{ kinds: [1], isBroad: true }]
    }
    const wss = { clients: [wsReceiver] }

    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_no_rebroadcast',
      content: 'hello'
    }

    broadcastMock.mock.resetCalls()
    await sendToClientsWithAMatchingFilter({ wss, event, eventLanguage: undefined })

    // sendToClientsWithAMatchingFilter should NOT call broadcast — only EventHandler.run does
    assert.equal(broadcastMock.mock.calls.length, 0)
  })
})
