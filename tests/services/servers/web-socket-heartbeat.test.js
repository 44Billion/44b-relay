import { after, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import WebSocket from 'ws'

let heartbeat
mock.module('#helpers/timer.js', {
  namedExports: {
    maybeUnref: timer => timer.unref(),
    setTimer: (schedule, callback, delay) => {
      assert.equal(schedule, setInterval)
      assert.equal(delay, 30000)
      heartbeat = callback
    }
  }
})
mock.module('#helpers/process.js', { namedExports: { addToCleanup: () => {} } })
const { default: wss } = await import('#services/servers/web-socket-server.js')
// The relay normally supplies this state after the server connection handler.
wss.on('connection', ws => { ws.nostr = { subscriptions: {} } })
after(() => new Promise(resolve => wss.close(resolve)))

async function connect (t, options = {}) {
  const http = createServer()
  http.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const connected = once(wss, 'connection')
  const client = new WebSocket(`ws://127.0.0.1:${http.address().port}`, options)
  t.after(async () => {
    if (client.readyState !== WebSocket.CLOSED) {
      const closed = once(client, 'close')
      client.terminate()
      await closed
    }
    await new Promise(resolve => http.close(resolve))
  })
  const opened = once(client, 'open')
  const [server] = await connected
  await opened
  return { client, server }
}

test('real automatic pongs keep an otherwise silent connection alive across heartbeat cycles', { timeout: 5000 }, async t => {
  const { client, server } = await connect(t)
  for (let cycle = 0; cycle < 4; cycle++) {
    const pong = once(server, 'pong')
    heartbeat()
    assert.equal(server.isAlive, false)
    await pong
    assert.equal(server.isAlive, true, 'the production pong listener must restore liveness')
    assert.equal(client.readyState, WebSocket.OPEN)
  }
})

test('a client that does not answer ping is still terminated on the next heartbeat', { timeout: 5000 }, async t => {
  const { client, server } = await connect(t, { autoPong: false })
  const ping = once(client, 'ping')
  heartbeat()
  await ping
  assert.equal(server.isAlive, false)
  const closed = once(client, 'close')
  heartbeat()
  const [code] = await closed
  assert.equal(code, 1006)
})
