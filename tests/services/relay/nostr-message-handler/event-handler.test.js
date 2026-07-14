import { describe, it, before, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { OLD_EVENT_AUTH_REQUIRED_AFTER_SECONDS, eventKinds } from '#constants/event.js'

// 1. Mock Rate Limiter
mock.module('#services/rate-limiting/web-socket-request-limiter.js', {
  namedExports: {
    rateLimitReqByPubkey: mock.fn(() => ({ isRateLimited: false })),
    disconnectWhenInactive: mock.fn()
  }
})

// 1b. Mock IPC Broadcaster
let currentWss

async function broadcastThroughCurrentWss (payload) {
  if (currentWss && sendToClientsWithAMatchingFilter) {
    await sendToClientsWithAMatchingFilter({ wss: currentWss, ...payload })
  }
  return true
}

const broadcastMock = mock.fn(broadcastThroughCurrentWss)
const waitUntilReadyMock = mock.fn(async () => true)
mock.module('#services/ipc/cross-process-broadcaster.js', {
  namedExports: {
    init: mock.fn(),
    broadcast: broadcastMock,
    waitUntilReady: waitUntilReadyMock
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

// 7. Mock Language Detection / Text Extraction
mock.module('#helpers/language.js', {
  namedExports: {
    detectEventLanguage: mock.fn(() => undefined),
    getEventText: mock.fn(event => event.content)
  }
})

// 8. Mock hashtag extraction
mock.module('#helpers/hashtag.js', {
  namedExports: {
    extractHashtags: mock.fn(() => [])
  }
})

// 9. Mock topic detection
mock.module('#services/topic/detector.js', {
  namedExports: {
    detectTopics: mock.fn(() => undefined)
  }
})

// Import SUT
// Note: We need to import AFTER mocks
const eventHandlerModule = await import('#services/relay/nostr-message-handler/event-handler.js')
const EventHandler = eventHandlerModule.default
const { sendToClientsWithAMatchingFilter } = eventHandlerModule
const { default: EventSaver } = await import('#services/event/saver/mdb/index.js')
const { getPopularityLevel } = await import('#services/event/maintainer/mdb/index.js')
const { detectEventLanguage } = await import('#helpers/language.js')
const { extractHashtags } = await import('#helpers/hashtag.js')
const { detectTopics } = await import('#services/topic/detector.js')

const createWss = (clients) => {
  currentWss = { clients }
  return currentWss
}

describe('EventHandler', () => {
  before(() => {
    process.env.RELAY_HOST = 'test.relay.com'
  })

  afterEach(() => {
    mock.reset()
    currentWss = null
    EventSaver.run.mock.resetCalls()
    broadcastMock.mock.resetCalls()
    broadcastMock.mock.mockImplementation(broadcastThroughCurrentWss)
    waitUntilReadyMock.mock.resetCalls()
    waitUntilReadyMock.mock.mockImplementation(async () => true)
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
    extractHashtags.mock.mockImplementation(() => [{ tag: 'pokemon', words: ['pokemon'], acronym: null }])
    detectTopics.mock.mockImplementation(() => ['pokemon', 'anime'])

    const wsSender = createWs('sender')
    const wsReceiver = createWs('receiver')

    // Receiver wants kind 1
    wsReceiver.nostr.subscriptions['sub1'] = {
      filters: [{ kinds: [1], isBroad: true }]
    }

    const wss = createWss([wsSender, wsReceiver])

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

    // 2. Should call EventSaver with propagated topics
    assert.equal(EventSaver.run.mock.calls.length, 1)
    const saverArgs = EventSaver.run.mock.calls[0].arguments[0]
    assert.deepEqual(saverArgs.topics, ['pokemon', 'anime'])

    // 3. Should broadcast with propagated topics. Local and remote live
    // delivery are now both performed by the IPC broadcaster.
    assert.equal(broadcastMock.mock.calls.length, 1)
    assert.deepEqual(broadcastMock.mock.calls[0].arguments[0].eventTopics, ['pokemon', 'anime'])

    // 4. The mocked broadcaster performs the local self-delivery path.
    assert.equal(wsReceiver.send.mock.calls.length, 1)
    const relayMsg = JSON.parse(wsReceiver.send.mock.calls[0].arguments[0])
    assert.deepEqual(relayMsg, ['EVENT', 'sub1', event])
  })

  it('should NOT relay if event is expired', async () => {
    EventSaver.run.mock.mockImplementation(async () => ({ isSuccess: true, isDuplicate: false, message: '' }))

    const wsSender = createWs('sender')
    const wsReceiver = createWs('receiver')
    wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ kinds: [1] }] }
    const wss = createWss([wsSender, wsReceiver])

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

  it('should use the old-event authentication window for kind 5 events', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      const now = Math.floor(Date.now() / 1000)
      const wss = createWss([])
      const withinWindowWs = createWs('within-window')
      const withinWindowEvent = {
        kind: eventKinds.DELETION,
        created_at: now - OLD_EVENT_AUTH_REQUIRED_AFTER_SECONDS + 1,
        tags: [],
        pubkey: 'deletion_pubkey',
        id: 'deletion_within_window',
        content: ''
      }

      await new EventHandler({ wss, ws: withinWindowWs, nostrMessage: ['EVENT', withinWindowEvent] }).run()

      assert.deepEqual(JSON.parse(withinWindowWs.send.mock.calls[0].arguments[0]), ['OK', 'deletion_within_window', true, ''])
      assert.equal(EventSaver.run.mock.calls.length, 1)

      const pastWindowWs = createWs('past-window')
      const pastWindowEvent = {
        ...withinWindowEvent,
        created_at: now - OLD_EVENT_AUTH_REQUIRED_AFTER_SECONDS - 1,
        id: 'deletion_past_window'
      }

      await new EventHandler({ wss, ws: pastWindowWs, nostrMessage: ['EVENT', pastWindowEvent] }).run()

      const rejection = JSON.parse(pastWindowWs.send.mock.calls[0].arguments[0])
      assert.deepEqual(rejection.slice(0, 3), ['OK', 'deletion_past_window', false])
      assert.match(rejection[3], /^auth-required:/)
      assert.equal(EventSaver.run.mock.calls.length, 1)
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
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
      const wss = createWss([wsSender, wsReceiver])

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
      const wss = createWss([wsSender, wsReceiver])

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
      const wss = createWss([wsSender, wsReceiver])

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
      const wss = createWss([wsSender, wsReceiver])

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
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ kinds: [1], language: ['pt'] }] }
      const wss = createWss([wsSender, wsReceiver])

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
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ kinds: [1], language: ['pt'] }] }
      const wss = createWss([wsSender, wsReceiver])

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
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ kinds: [1], language: ['en'] }] }
      const wss = createWss([wsSender, wsReceiver])

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
    const wss = createWss([wsSender, wsReceiver])

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

  it('should relay to filter with multiple languages if event language matches one', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 1)
      detectEventLanguage.mock.mockImplementation(() => 'en')

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ kinds: [1], language: ['pt', 'en'] }] }
      const wss = createWss([wsSender, wsReceiver])

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'pubkey1',
        id: 'event_multi_lang_match',
        content: 'Hello world'
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

  it('should NOT relay to filter with multiple languages if event language matches none', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 1)
      detectEventLanguage.mock.mockImplementation(() => 'fr')

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ kinds: [1], language: ['pt', 'en'] }] }
      const wss = createWss([wsSender, wsReceiver])

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'pubkey1',
        id: 'event_multi_lang_no_match',
        content: 'Bonjour le monde'
      }

      const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
      await handler.run()

      const ackMsg = JSON.parse(wsSender.send.mock.calls[0].arguments[0])
      assert.equal(ackMsg[2], true)
      assert.equal(wsReceiver.send.mock.calls.length, 0)
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should relay to filter with isRising when author popularity is exactly 6', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 6)

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ isBroad: true, isRising: true }] }
      const wss = createWss([wsSender, wsReceiver])

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'rising_pubkey',
        id: 'event_is_rising',
        content: 'rising author'
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

  it('should NOT relay to filter with isRising when author popularity is not 6', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 3)

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ isBroad: true, isRising: true }] }
      const wss = createWss([wsSender, wsReceiver])

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'popular_pubkey',
        id: 'event_not_rising',
        content: 'popular author'
      }

      const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
      await handler.run()

      assert.equal(wsReceiver.send.mock.calls.length, 0)
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should relay to filter with isPopular when author popularity is <= 5', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 3)

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ isBroad: true, isPopular: true }] }
      const wss = createWss([wsSender, wsReceiver])

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'popular_pubkey',
        id: 'event_is_popular',
        content: 'popular author'
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

  it('should NOT relay to filter with isPopular when author popularity is > 5', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 6)

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      wsReceiver.nostr.subscriptions['sub1'] = { filters: [{ isBroad: true, isPopular: true }] }
      const wss = createWss([wsSender, wsReceiver])

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'rising_pubkey',
        id: 'event_not_popular',
        content: 'rising author'
      }

      const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
      await handler.run()

      assert.equal(wsReceiver.send.mock.calls.length, 0)
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should relay to OR-combined audience filters (isSpam OR isRising)', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 6) // matches isRising but not isSpam

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      wsReceiver.nostr.subscriptions['sub1'] = {
        filters: [{ isBroad: true, isSpam: true, isRising: true }]
      }
      const wss = createWss([wsSender, wsReceiver])

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'rising_pubkey',
        id: 'event_or_combined',
        content: 'OR combined'
      }

      const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
      await handler.run()

      assert.equal(wsReceiver.send.mock.calls.length, 1)
    } finally {
      process.env.IS_INTEGRATION_TEST = originalEnv
    }
  })

  it('should NOT relay to OR-combined audience filters when author matches none', async () => {
    const originalEnv = process.env.IS_INTEGRATION_TEST
    process.env.IS_INTEGRATION_TEST = 'false'

    try {
      getPopularityLevel.mock.mockImplementation(() => 3) // matches neither isSpam nor isRising

      const wsSender = createWs('sender')
      const wsReceiver = createWs('receiver')
      wsReceiver.nostr.subscriptions['sub1'] = {
        filters: [{ isBroad: true, isSpam: true, isRising: true }]
      }
      const wss = createWss([wsSender, wsReceiver])

      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: 'popular_pubkey',
        id: 'event_or_combined_no_match',
        content: 'OR combined no match'
      }

      const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
      await handler.run()

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
    const wss = createWss([wsSender, wsReceiver])

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
    const wss = createWss([wsSender])

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
    const wss = createWss([wsSender])

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
    assert.equal(EventSaver.run.mock.calls.length, 0)
  })

  it('should let broadcaster self-delivery reach local subscribers', async () => {
    getPopularityLevel.mock.mockImplementation(() => 1)

    const wsSender = createWs('sender')
    const wsReceiver = createWs('receiver')
    wsReceiver.nostr.subscriptions.sub1 = { filters: [{ kinds: [1], isBroad: true }] }
    const wss = createWss([wsSender, wsReceiver])

    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_self_delivery',
      content: 'hello'
    }

    broadcastMock.mock.mockImplementationOnce(async payload => {
      await sendToClientsWithAMatchingFilter({ wss, ...payload })
      return true
    })

    const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
    await handler.run()

    assert.equal(wsReceiver.send.mock.calls.length, 1)
    const relayMsg = JSON.parse(wsReceiver.send.mock.calls[0].arguments[0])
    assert.equal(relayMsg[0], 'EVENT')
    assert.equal(relayMsg[1], 'sub1')
    assert.deepEqual(relayMsg[2], event)
  })

  it('should reject and skip persistence when ipc is not ready', async () => {
    waitUntilReadyMock.mock.mockImplementationOnce(async () => false)

    const wsSender = createWs('sender')
    const wss = createWss([wsSender])
    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_ipc_not_ready',
      content: 'hello'
    }

    const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
    await handler.run()

    assert.equal(EventSaver.run.mock.calls.length, 0)
    assert.equal(broadcastMock.mock.calls.length, 0)
    const ackMsg = JSON.parse(wsSender.send.mock.calls[0].arguments[0])
    assert.deepEqual(ackMsg, ['OK', 'event_ipc_not_ready', false, 'error: relay IPC unavailable; retry'])
  })

  it('should reject when ipc broadcast fails after persistence', async () => {
    EventSaver.run.mock.mockImplementation(async () => ({ isSuccess: true, isDuplicate: false, message: '' }))
    broadcastMock.mock.mockImplementationOnce(async () => false)

    const wsSender = createWs('sender')
    const wss = createWss([wsSender])
    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_ipc_broadcast_failed',
      content: 'hello'
    }

    const handler = new EventHandler({ wss, ws: wsSender, nostrMessage: ['EVENT', event] })
    await handler.run()

    assert.equal(EventSaver.run.mock.calls.length, 1)
    assert.equal(broadcastMock.mock.calls.length, 1)
    const ackMsg = JSON.parse(wsSender.send.mock.calls[0].arguments[0])
    assert.deepEqual(ackMsg, ['OK', 'event_ipc_broadcast_failed', false, 'error: relay IPC unavailable; retry'])
  })

  it('should NOT call broadcast when shouldRelay is false (duplicate)', async () => {
    EventSaver.run.mock.mockImplementation(async () => ({ isSuccess: true, isDuplicate: true, message: 'duplicate: already have this event' }))

    const wsSender = createWs('sender')
    const wss = createWss([wsSender])

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
    const wss = createWss([wsSender])

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
    const wss = createWss([wsReceiver])

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
    const wss = createWss([wsReceiver])

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
    const wss = createWss([wsReceiver])

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
    const wss = createWss([wsReceiver])

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
    const wss = createWss([ws1, ws2])

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
    const wss = createWss([wsReceiver])

    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_no_rebroadcast',
      content: 'hello'
    }

    broadcastMock.mock.resetCalls()
    broadcastMock.mock.mockImplementation(async () => true)
    waitUntilReadyMock.mock.resetCalls()
    waitUntilReadyMock.mock.mockImplementation(async () => true)
    await sendToClientsWithAMatchingFilter({ wss, event, eventLanguage: undefined })

    // sendToClientsWithAMatchingFilter should NOT call broadcast — only EventHandler.run does
    assert.equal(broadcastMock.mock.calls.length, 0)
  })

  it('should relay to clients with matching topic filter using propagated eventTopics', async () => {
    getPopularityLevel.mock.mockImplementation(() => 1)

    const wsReceiver = createWs('receiver')
    wsReceiver.nostr.subscriptions.sub1 = {
      filters: [{ kinds: [1], topic: ['pokemon'], isBroad: true }]
    }
    const wss = createWss([wsReceiver])

    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_topic_match',
      content: 'hello'
    }

    await sendToClientsWithAMatchingFilter({ wss, event, eventLanguage: undefined, eventTopics: ['pokemon', 'anime'] })

    assert.equal(wsReceiver.send.mock.calls.length, 1)
  })

  it('should NOT relay to clients when topic filter does not match propagated eventTopics', async () => {
    getPopularityLevel.mock.mockImplementation(() => 1)

    const wsReceiver = createWs('receiver')
    wsReceiver.nostr.subscriptions.sub1 = {
      filters: [{ kinds: [1], topic: ['bitcoin'], isBroad: true }]
    }
    const wss = createWss([wsReceiver])

    const event = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey: 'pubkey1',
      id: 'event_topic_no_match',
      content: 'hello'
    }

    await sendToClientsWithAMatchingFilter({ wss, event, eventLanguage: undefined, eventTopics: ['pokemon', 'anime'] })

    assert.equal(wsReceiver.send.mock.calls.length, 0)
  })

  // Regression: private delivery and throwaway-author kinds were silently dropped on broad-flagged
  // subscriptions because their authors have popularity 999.
  // Filters of the form {kinds:[K], "#p":[me]} are flagged isBroad by isBroadFilter
  // (precision = 1 since kinds-with-non-#d-tag still totals 1), so the pre-fix
  // popularity gate dropped every event. This affected:
  // - NIP-46 SIGNER_RPC (kind 24133) — ephemeral signer keys are throwaway
  // - NIP-17/NIP-59 gift wraps (kind 1059) — author key is throwaway by design
  // Without the fix, IPC delivery from one process to another for these
  // subscriptions silently fails for any client subscribing through these patterns.
  describe('private delivery and throwaway-author kinds bypass popularity gate', () => {
    it('should relay ephemeral SIGNER_RPC (kind 24133) on a broad #p filter even when author popularity is 999', async () => {
      const originalEnv = process.env.IS_INTEGRATION_TEST
      process.env.IS_INTEGRATION_TEST = 'false'

      try {
        getPopularityLevel.mock.mockImplementation(() => 999)

        const wsReceiver = createWs('receiver')
        // Typical NIP-46 client subscription
        wsReceiver.nostr.subscriptions.sub1 = {
          filters: [{ kinds: [24133], '#p': ['client_pubkey'], isBroad: true }]
        }
        const wss = createWss([wsReceiver])

        const event = {
          kind: 24133,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', 'client_pubkey']],
          pubkey: 'throwaway_signer_pubkey',
          id: 'event_signer_rpc',
          content: 'encrypted_payload'
        }

        await sendToClientsWithAMatchingFilter({ wss, event, eventLanguage: undefined })

        assert.equal(wsReceiver.send.mock.calls.length, 1)
        const relayMsg = JSON.parse(wsReceiver.send.mock.calls[0].arguments[0])
        assert.equal(relayMsg[0], 'EVENT')
        assert.equal(relayMsg[1], 'sub1')
      } finally {
        process.env.IS_INTEGRATION_TEST = originalEnv
      }
    })

    it('should relay NIP-17/NIP-59 gift wrap (kind 1059) on a broad #p filter even when author popularity is 999', async () => {
      const originalEnv = process.env.IS_INTEGRATION_TEST
      process.env.IS_INTEGRATION_TEST = 'false'

      try {
        getPopularityLevel.mock.mockImplementation(() => 999)

        const wsReceiver = createWs('receiver')
        wsReceiver.nostr.subscriptions.sub1 = {
          filters: [{ kinds: [1059], '#p': ['recipient_pubkey'], isBroad: true }]
        }
        const wss = createWss([wsReceiver])

        const event = {
          kind: 1059,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', 'recipient_pubkey']],
          pubkey: 'throwaway_giftwrap_pubkey',
          id: 'event_gift_wrap',
          content: 'encrypted_seal'
        }

        await sendToClientsWithAMatchingFilter({ wss, event, eventLanguage: undefined })

        assert.equal(wsReceiver.send.mock.calls.length, 1)
        const relayMsg = JSON.parse(wsReceiver.send.mock.calls[0].arguments[0])
        assert.equal(relayMsg[0], 'EVENT')
        assert.equal(relayMsg[1], 'sub1')
      } finally {
        process.env.IS_INTEGRATION_TEST = originalEnv
      }
    })

    it('should relay private-channel broadcast (kind 3560) on a broad filter even when channel popularity is 999', async () => {
      const originalEnv = process.env.IS_INTEGRATION_TEST
      process.env.IS_INTEGRATION_TEST = 'false'

      try {
        getPopularityLevel.mock.mockImplementation(() => 999)

        const wsReceiver = createWs('receiver')
        wsReceiver.nostr.subscriptions.sub1 = {
          filters: [{ kinds: [eventKinds.PRIVATE_CHANNEL_BROADCAST], isBroad: true }]
        }
        const wss = createWss([wsReceiver])

        const event = {
          kind: eventKinds.PRIVATE_CHANNEL_BROADCAST,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          pubkey: 'private_channel_pubkey',
          id: 'event_private_channel_broadcast',
          content: 'encrypted_router'
        }

        await sendToClientsWithAMatchingFilter({ wss, event, eventLanguage: undefined })

        assert.equal(wsReceiver.send.mock.calls.length, 1)
        const relayMsg = JSON.parse(wsReceiver.send.mock.calls[0].arguments[0])
        assert.equal(relayMsg[0], 'EVENT')
        assert.equal(relayMsg[1], 'sub1')
      } finally {
        process.env.IS_INTEGRATION_TEST = originalEnv
      }
    })

    it('should relay any ephemeral kind on a broad filter even when author popularity is 999', async () => {
      const originalEnv = process.env.IS_INTEGRATION_TEST
      process.env.IS_INTEGRATION_TEST = 'false'

      try {
        getPopularityLevel.mock.mockImplementation(() => 999)

        const wsReceiver = createWs('receiver')
        // Bare {kinds:[ephemeral]} filter — broad by isBroadFilter (precision 1).
        wsReceiver.nostr.subscriptions.sub1 = {
          filters: [{ kinds: [29999], isBroad: true }]
        }
        const wss = createWss([wsReceiver])

        const event = {
          kind: 29999,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          pubkey: 'unknown_pubkey',
          id: 'event_other_ephemeral',
          content: ''
        }

        await sendToClientsWithAMatchingFilter({ wss, event, eventLanguage: undefined })

        assert.equal(wsReceiver.send.mock.calls.length, 1)
      } finally {
        process.env.IS_INTEGRATION_TEST = originalEnv
      }
    })

    it('should still drop a regular non-throwaway kind on a broad filter when author popularity is 999', async () => {
      const originalEnv = process.env.IS_INTEGRATION_TEST
      process.env.IS_INTEGRATION_TEST = 'false'

      try {
        getPopularityLevel.mock.mockImplementation(() => 999)

        const wsReceiver = createWs('receiver')
        wsReceiver.nostr.subscriptions.sub1 = {
          filters: [{ kinds: [1], '#p': ['recipient_pubkey'], isBroad: true }]
        }
        const wss = createWss([wsReceiver])

        const event = {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', 'recipient_pubkey']],
          pubkey: 'spammy_pubkey',
          id: 'event_regular_note',
          content: 'spam mention'
        }

        await sendToClientsWithAMatchingFilter({ wss, event, eventLanguage: undefined })

        assert.equal(wsReceiver.send.mock.calls.length, 0)
      } finally {
        process.env.IS_INTEGRATION_TEST = originalEnv
      }
    })
  })
})
