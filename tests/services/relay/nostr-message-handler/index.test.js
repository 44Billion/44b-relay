import { describe, it, before, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto' // for random pubkeys

import NostrMessageHandler from '#services/relay/nostr-message-handler/index.js'
import AuthHandler from '#services/relay/nostr-message-handler/auth-handler.js'
import EventHandler from '#services/relay/nostr-message-handler/event-handler.js'
import ReqHandler from '#services/relay/nostr-message-handler/req-handler.js'
import CloseHandler from '#services/relay/nostr-message-handler/close-handler.js'
import { eventKinds } from '#constants/event.js'

describe('NostrMessageHandler', () => {
  // Spies/Mocks we control
  const authRunMock = mock.fn()
  const eventRunMock = mock.fn()
  const reqRunMock = mock.fn()
  const closeRunMock = mock.fn()

  // We override the methods on the imported objects
  // This works because they are likely singletons or class static methods
  // If they are classes, ensure we target the static method

  before(() => {
    AuthHandler.run = authRunMock
    EventHandler.run = eventRunMock
    ReqHandler.run = reqRunMock
    CloseHandler.run = closeRunMock
  })

  beforeEach(() => {
    authRunMock.mock.resetCalls()
    eventRunMock.mock.resetCalls()
    reqRunMock.mock.resetCalls()
    closeRunMock.mock.resetCalls()
  })

  const createWs = () => ({
    nostr: {
      pubkey: crypto.randomBytes(32).toString('hex'),
      subscriptions: {}
    },
    send: mock.fn(),
    ip: '127.0.0.1'
  })

  const wss = { clients: new Set() }

  it('should send notice if nostrMessage is missing/null', () => {
    const ws = createWs()
    const handler = new NostrMessageHandler({ wss, ws, nostrMessage: null })
    handler.run()

    assert.equal(ws.send.mock.callCount(), 1)
    const sent = JSON.parse(ws.send.mock.calls[0].arguments[0])
    assert.equal(sent[0], 'NOTICE')
    assert.match(sent[1], /failed to parse/)
  })

  it('should delegate EVENT messages to EventHandler', () => {
    const ws = createWs()
    wss.clients.add(ws)
    const nostrMessage = ['EVENT', { kind: 1, content: 'hello' }]
    const handler = new NostrMessageHandler({ wss, ws, nostrMessage })
    handler.run()

    assert.equal(eventRunMock.mock.callCount(), 1)
    assert.equal(reqRunMock.mock.callCount(), 0)
  })

  it('should delegate REQ messages to ReqHandler', () => {
    const ws = createWs()
    wss.clients.add(ws)
    const nostrMessage = ['REQ', 'sub1', {}]
    const handler = new NostrMessageHandler({ wss, ws, nostrMessage })
    handler.run()

    assert.equal(reqRunMock.mock.callCount(), 1)
  })

  it('should delegate AUTH messages to AuthHandler', () => {
    const ws = createWs()
    wss.clients.add(ws)
    const nostrMessage = ['AUTH', { kind: 22242 }]
    const handler = new NostrMessageHandler({ wss, ws, nostrMessage })
    handler.run()

    assert.equal(authRunMock.mock.callCount(), 1)
  })

  it('should delegate CLOSE messages to CloseHandler', () => {
    const ws = createWs()
    wss.clients.add(ws)
    const nostrMessage = ['CLOSE', 'sub1']
    const handler = new NostrMessageHandler({ wss, ws, nostrMessage })
    handler.run()

    assert.equal(closeRunMock.mock.callCount(), 1)
  })

  it('should update lastActiveAtMs on ws.nostr', () => {
    const ws = createWs()
    wss.clients.add(ws)
    const nostrMessage = ['REQ', 'sub1']
    const now = Date.now()
    const handler = new NostrMessageHandler({ wss, ws, nostrMessage })
    handler.run()

    assert.ok(ws.nostr.lastActiveAtMs >= now)
  })

  describe('Message Length Limits', () => {
    it('should block huge REQ message', () => {
      const ws = createWs()
      wss.clients.add(ws)
      const hugeFilter = { ids: Array(10000).fill('a') }
      const nostrMessage = ['REQ', 'sub1', hugeFilter]
      // We artificially set byteLength to verify logic
      nostrMessage.byteLength = 10 * 1024 * 1024 // 10MB

      const handler = new NostrMessageHandler({ wss, ws, nostrMessage })
      handler.run()

      assert.equal(reqRunMock.mock.callCount(), 0)
      assert.equal(ws.send.mock.callCount(), 1)
      const sent = JSON.parse(ws.send.mock.calls[0].arguments[0])
      assert.equal(sent[0], 'OK')
      assert.equal(sent[2], false)
      assert.match(sent[3], /too long/)
    })

    it('should block huge EVENT content', () => {
      const ws = createWs()
      wss.clients.add(ws)
      const content = 'a'.repeat(9 * 1024) // 9KB > 8KB limit
      const event = { kind: eventKinds.TEXT_NOTE, content }
      const nostrMessage = ['EVENT', event]

      const handler = new NostrMessageHandler({ wss, ws, nostrMessage })
      handler.run()

      assert.equal(eventRunMock.mock.callCount(), 0)
      assert.equal(ws.send.mock.callCount(), 1)
      const sent = JSON.parse(ws.send.mock.calls[0].arguments[0])
      assert.equal(sent[0], 'OK')
      assert.equal(sent[2], false)
    })
  })

  describe('Rate Limiting Strategy', () => {
    it('should block execution when rate limit is exceeded (Volume Test)', () => {
      const ws = createWs()
      wss.clients.add(ws)

      // We fire multiple messages
      // Using AUTH messages as they have distinct limit
      let blockedCount = 0
      for (let i = 0; i < 25; i++) {
        const nostrMessage = ['AUTH', { kind: 22242 }]
        const handler = new NostrMessageHandler({ wss, ws, nostrMessage })
        handler.run()
        if (authRunMock.mock.callCount() === (i + 1 - blockedCount)) {
          // Passed
        } else {
          blockedCount++
        }
      }

      assert.ok(blockedCount > 0, 'Should have blocked some requests due to rate limiting')
    })

    it('should update lastActiveAtMs even if request is rate limited', async () => {
      const ws = createWs()
      wss.clients.add(ws)

      const start = Date.now()
      // Wait 1ms to ensure strict inequality
      await new Promise(resolve => setTimeout(resolve, 1))

      // Trigger rate limit
      for (let i = 0; i < 50; i++) {
        const nostrMessage = ['AUTH', { kind: 22242 }]
        const handler = new NostrMessageHandler({ wss, ws, nostrMessage })
        handler.run()
      }

      assert.ok(ws.nostr.lastActiveAtMs > start, 'Should have updated activity timestamp')
    })
  })
})
