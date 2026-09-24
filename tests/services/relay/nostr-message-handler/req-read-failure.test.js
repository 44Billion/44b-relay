import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let read = async () => ({ success: true, result: [] })
mock.module('#models/event/dao.js', { namedExports: { getEvents: (...args) => read(...args) } })
mock.module('#models/event/mapper.js', { namedExports: { addressToRef: () => 'ref' } })
mock.module('#helpers/event.js', { namedExports: { isKnownEventKind: () => true, getPublishedAt: event => event.created_at } })
mock.module('#services/event/tracker/mdb/requested-pubkeys.js', {
  namedExports: {
    getFilterInterests: () => ({ pubkeys: new Set(), ids: {} }),
    uninterestedIn: { kinds: {} },
    trackRequestedPubkeys: () => {}
  }
})
mock.module('#services/event/tracker/mdb/requested-events.js', { namedExports: { trackRequestedEvents: () => {} } })
mock.module('#services/event/tracker/mdb/ip-activity.js', { namedExports: { trackIpActivity: () => {} } })
mock.module('#services/rate-limiting/web-socket-request-limiter.js', { namedExports: { disconnectWhenInactive: () => {} } })
const { default: ReqHandler } = await import('#services/relay/nostr-message-handler/req-handler.js')
const { default: BroadStrategy } = await import('#services/event/fetcher/mdb/broad-strategy.js')
const author = 'a'.repeat(64)
const createWs = () => {
  const messages = []
  return { nostr: { subscriptions: {} }, readyState: 1, send: message => messages.push(JSON.parse(message)), messages }
}
const run = (ws, filters = [{ authors: [author], kinds: [1] }]) => ReqHandler.run({ ws, wss: {}, nostrMessage: ['REQ', 'same-id', ...filters] })

test('failed and thrown DAO reads propagate instead of becoming an empty snapshot', async () => {
  const cause = new Error('private database details')
  read = async () => ({ success: false, result: null, error: cause })
  await assert.rejects(async () => { for await (const event of BroadStrategy.run({})) assert.fail(event) }, error => error.cause === cause)
  read = async () => { throw cause }
  await assert.rejects(async () => { for await (const event of BroadStrategy.run({})) assert.fail(event) }, error => error === cause)
})

test('REQ failure emits CLOSED without EOSE or retained live subscription, including after partial results', async t => {
  t.mock.method(console, 'error', () => {})
  for (const partial of [false, true]) {
    const ws = createWs()
    let calls = 0
    read = async () => {
      if (partial && calls++ === 0) return { success: true, result: [{ id: 'b'.repeat(64), pubkey: author, kind: 1, tags: [] }] }
      return { success: false, result: null, error: new Error('database secret') }
    }
    const filter = { authors: [author], kinds: [1] }
    await run(ws, partial ? [filter, { ...filter, kinds: [2] }] : [filter])
    assert.deepEqual(ws.messages.at(-1), ['CLOSED', 'same-id', 'error: failed to read stored events'])
    assert.equal(ws.messages.some(message => message[0] === 'EOSE'), false)
    assert.equal(ws.messages.filter(message => message[0] === 'EVENT').length, Number(partial))
    assert.deepEqual(ws.nostr.subscriptions, {})
    assert.equal(JSON.stringify(ws.messages).includes('database secret'), false)
  }
})

test('a genuinely empty successful read still emits EOSE and enables live', async () => {
  read = async () => ({ success: true, result: [] })
  const ws = createWs()
  await run(ws)
  assert.deepEqual(ws.messages, [['EOSE', 'same-id']])
  assert.equal(ws.nostr.subscriptions['same-id'].filters.length, 1)
})

for (const fail of [false, true]) {
  test(`replaced REQ ignores late ${fail ? 'failure' : 'results and EOSE'}, even within the same millisecond`, async t => {
    t.mock.method(Date, 'now', () => 1700000000000)
    t.mock.method(console, 'error', () => {})
    const pending = Promise.withResolvers()
    read = () => pending.promise
    const ws = createWs()
    const oldRequest = run(ws)
    read = async () => ({ success: true, result: [] })
    await run(ws, [{ authors: [author], kinds: [2] }])
    const replacement = ws.nostr.subscriptions['same-id']
    pending.resolve(fail
      ? { success: false, error: new Error('old failed') }
      : { success: true, result: [{ id: 'old', kind: 1, tags: [] }] })
    await oldRequest
    assert.equal(ws.nostr.subscriptions['same-id'], replacement)
    assert.deepEqual(ws.messages, [['EOSE', 'same-id']])
  })
}
