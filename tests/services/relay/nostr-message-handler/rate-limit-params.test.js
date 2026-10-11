import { test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { sendCommandResult, sendClosed } from '#helpers/message.js'

// Isolate the response protocol from database-backed work and network access.
for (const name of ['auth', 'event', 'req', 'count']) {
  mock.module(`#services/relay/nostr-message-handler/${name}-handler.js`, {
    defaultExport: { run: () => assert.fail('rate-limited work must not reach a handler') }
  })
}
mock.module('#services/rate-limiting/web-socket-request-limiter.js', { namedExports: { disconnectWhenInactive: () => {} } })
mock.module('#helpers/tor.js', { namedExports: { isTorExitNode: () => false } })

let limits = {}
mock.module('#services/rate-limiting/nostr-message-limiter.js', {
  namedExports: Object.fromEntries([
    'rateLimitNostrMessageByPubkey',
    'rateLimitNostrAuthMessageByPubkey',
    'rateLimitNostrReqMessageByWsConnection',
    'rateLimitNostrReqMessageByPubkey',
    'rateLimitNostrEventMessageByPubkey'
  ].map(name => [name, () => limits[name] ?? { isRateLimited: false }]))
})
const { default: NostrMessageHandler } = await import('#services/relay/nostr-message-handler/index.js')

beforeEach(t => {
  limits = {}
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
})

const event = { id: 'event-id', kind: 1 }
const auth = { id: 'auth-id', kind: 22242 }
const cases = [
  { message: ['EVENT', event], response: ['OK', event.id, false] },
  { message: ['AUTH', auth], response: ['OK', auth.id, false] },
  { message: ['REQ', 'sub1', {}], response: ['CLOSED', 'sub1'] },
  { message: ['COUNT', 'count1', {}], response: ['CLOSED', 'count1'] }
]

function run (nostrMessage) {
  const sent = []
  const ws = { ip: 'params-test-ip', nostr: { subscriptions: {} }, send: raw => sent.push(JSON.parse(raw)) }
  new NostrMessageHandler({ ws, wss: { clients: new Set([ws]) }, nostrMessage }).run()
  return sent
}

for (const { message, response } of cases) {
  test(`global rate-limited ${message[0]} returns decimal milliseconds in ${response[0]}`, () => {
    limits.rateLimitNostrMessageByPubkey = { isRateLimited: true, nextWindow: new Date(12500) }
    assert.deepEqual(run(message), [[...response, 'rate-limited: too many messages', '2500']])
  })

  for (const remainingMs of [1, 0, -1000]) {
    test(`rate-limited ${message[0]} clamps a deadline ${remainingMs} ms away to "1"`, () => {
      limits.rateLimitNostrMessageByPubkey = { isRateLimited: true, nextWindow: new Date(10000 + remainingMs) }
      assert.deepEqual(run(message), [[...response, 'rate-limited: too many messages', '1']])
    })
  }

  test(`rate-limited ${message[0]} omits params when no retry deadline is known`, () => {
    limits.rateLimitNostrMessageByPubkey = { isRateLimited: true }
    assert.deepEqual(run(message), [[...response, 'rate-limited: too many messages']])
  })
}

for (const { name, message, reason } of [
  { name: 'rateLimitNostrAuthMessageByPubkey', message: ['AUTH', auth], reason: 'too many auth attempts' },
  { name: 'rateLimitNostrEventMessageByPubkey', message: ['EVENT', event], reason: 'too many kind:1 events' }
]) {
  test(`${message[0]}-specific rate limit returns milliseconds in rejected OK`, () => {
    limits[name] = { isRateLimited: true, nextWindow: new Date(12500) }
    assert.deepEqual(run(message), [['OK', message[1].id, false, `rate-limited: ${reason}`, '2500']])
  })
}

for (const { name, reason } of [
  { name: 'rateLimitNostrReqMessageByWsConnection', reason: 'too many subscriptions on this connection' },
  { name: 'rateLimitNostrReqMessageByPubkey', reason: 'too many subscriptions or filters for this pubkey' }
]) {
  test(`${name} omits params in CLOSED without a retry deadline`, () => {
    limits[name] = { isRateLimited: true }
    assert.deepEqual(run(['REQ', 'sub1', {}]), [['CLOSED', 'sub1', `rate-limited: ${reason}`]])
  })
}

test('ordinary successful OK, rejected OK and CLOSED omit the optional parameter', () => {
  const sent = []
  const ws = { send: raw => sent.push(JSON.parse(raw)) }
  sendCommandResult({ ws, event, isSuccess: true })
  sendCommandResult({ ws, event, isSuccess: false, message: 'invalid: bad event' })
  sendClosed({ ws, subscriptionId: 'sub1', message: 'error: failed to read stored events' })
  assert.deepEqual(sent, [
    ['OK', event.id, true, ''],
    ['OK', event.id, false, 'invalid: bad event'],
    ['CLOSED', 'sub1', 'error: failed to read stored events']
  ])
})
