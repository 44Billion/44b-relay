import { test } from 'node:test'
import assert from 'node:assert/strict'
import NostrMessageHandler from '#services/relay/nostr-message-handler/index.js'
import { rateLimitNostrMessageByPubkey, MESSAGE_GLOBAL_REQS_PER_WINDOW } from '#services/rate-limiting/nostr-message-limiter.js'

test('CLOSE releases a real subscription and its timer even when the shared work budget is exhausted', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 })
  const sent = []
  const ws = { ip: 'close-test-ip', nostr: { subscriptions: { active: {}, keep: {}, limited: {} } }, send: raw => sent.push(JSON.parse(raw)) }
  let expired = false
  ws.nostr.subscriptions.active.cleanupTimeout = setTimeout(() => { expired = true }, 2000)
  const wss = { clients: new Set([ws]) }
  for (let i = 0; i < MESSAGE_GLOBAL_REQS_PER_WINDOW; i++) rateLimitNostrMessageByPubkey(ws)
  new NostrMessageHandler({ wss, ws, nostrMessage: ['REQ', 'limited', {}] }).run()
  assert.equal(ws.nostr.subscriptions.limited, undefined, 'rejected renewal really closes the old subscription')
  assert.equal(sent.at(-1)[0], 'CLOSED')
  assert.match(sent.at(-1)[2], /^rate-limited:/)
  assert.ok(sent.at(-1)[3].retry_after > 0)
  const count = sent.length
  new NostrMessageHandler({ wss, ws, nostrMessage: ['CLOSE', 'active'] }).run()
  assert.equal(ws.nostr.subscriptions.active, undefined)
  assert.ok(ws.nostr.subscriptions.keep)
  assert.equal(sent.length, count)
  assert.equal(rateLimitNostrMessageByPubkey(ws).isRateLimited, true)
  t.mock.timers.tick(2000)
  assert.equal(expired, false)
})

test('malformed CLOSE does not delete a subscription by object coercion', () => {
  const sent = []
  const ws = { ip: 'invalid-close-ip', nostr: { subscriptions: { '[object Object]': {} } }, send: raw => sent.push(JSON.parse(raw)) }
  new NostrMessageHandler({ wss: { clients: new Set([ws]) }, ws, nostrMessage: ['CLOSE', {}] }).run()
  assert.ok(ws.nostr.subscriptions['[object Object]'])
  assert.equal(sent[0][0], 'NOTICE')
})
