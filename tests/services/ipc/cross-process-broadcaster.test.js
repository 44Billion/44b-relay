import { describe, it, afterEach, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

mock.module('#helpers/process.js', {
  namedExports: {
    addToCleanup: mock.fn()
  }
})

let init
let broadcast
let createBroadcaster

const broadcasters = new Set()
const silentLogger = { log () {}, warn () {}, error () {} }

function socketPath (name) {
  return path.join(os.tmpdir(), `44b-relay-ipc-${process.pid}-${Date.now()}-${name}.sock`)
}

function cleanupPath (socket) {
  try { fs.unlinkSync(socket) } catch {}
  try { fs.unlinkSync(`${socket}.lock`) } catch {}
}

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor (fn, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return
    await wait(intervalMs)
  }
  assert.fail('timed out waiting for condition')
}

function makeBroadcaster (socket, options = {}) {
  const instance = createBroadcaster({
    socketPath: socket,
    lockPath: `${socket}.lock`,
    connectRetryMs: 20,
    staleProbeTimeoutMs: 30,
    lockStaleMs: 100,
    broadcastTimeoutMs: 500,
    addCleanup: () => {},
    logger: silentLogger,
    ...options
  })
  broadcasters.add(instance)
  return instance
}

describe('cross-process-broadcaster', () => {
  before(async () => {
    ;({ init, broadcast, createBroadcaster } = await import('#services/ipc/cross-process-broadcaster.js'))
  })

  afterEach(async () => {
    await Promise.all([...broadcasters].map(instance => instance.close().catch(() => {})))
    broadcasters.clear()
  })

  it('skips default initialization in test mode and default broadcast fails closed', async () => {
    init(() => {})
    assert.equal(await broadcast({ event: { id: 'test' } }, { timeoutMs: 10 }), false)
  })

  it('exchanges messages between two instances through one unix socket', async () => {
    const socket = socketPath('exchange')
    cleanupPath(socket)
    const receivedA = []
    const receivedB = []
    const a = makeBroadcaster(socket)
    const b = makeBroadcaster(socket)

    a.init(data => receivedA.push(data))
    b.init(data => receivedB.push(data))

    assert.equal(await a.waitUntilReady({ timeoutMs: 1000 }), true)
    assert.equal(await b.waitUntilReady({ timeoutMs: 1000 }), true)

    const first = { event: { id: 'from-a' }, eventLanguage: 'en' }
    assert.equal(await a.broadcast(first, { timeoutMs: 1000 }), true)
    await waitFor(() => receivedA.length === 1 && receivedB.length === 1)
    assert.deepEqual(receivedA[0], first)
    assert.deepEqual(receivedB[0], first)

    const second = { event: { id: 'from-b' } }
    assert.equal(await b.broadcast(second, { timeoutMs: 1000 }), true)
    await waitFor(() => receivedA.length === 2 && receivedB.length === 2)
    assert.deepEqual(receivedA[1], second)
    assert.deepEqual(receivedB[1], second)

    await Promise.all([a.close(), b.close()])
    cleanupPath(socket)
  })

  it('recovers a stale socket with one elected server', async () => {
    const socket = socketPath('stale')
    cleanupPath(socket)
    fs.writeFileSync(socket, '')

    const instances = [0, 1, 2, 3].map(() => makeBroadcaster(socket))
    const received = instances.map(() => [])
    instances.forEach((instance, index) => instance.init(data => received[index].push(data)))

    const ready = await Promise.all(instances.map(instance => instance.waitUntilReady({ timeoutMs: 3000 })))
    assert.deepEqual(ready, [true, true, true, true])
    await waitFor(() => instances.filter(instance => instance.isServer()).length === 1)
    assert.equal(instances.filter(instance => instance.isServer()).length, 1)

    assert.equal(await instances[0].broadcast({ id: 'after-stale' }, { timeoutMs: 1000 }), true)
    await waitFor(() => received.every(items => items.length === 1))

    await Promise.all(instances.map(instance => instance.close()))
    cleanupPath(socket)
  })

  it('reconnects workers after the current ipc server closes', async () => {
    const socket = socketPath('reconnect')
    cleanupPath(socket)
    const receivedA = []
    const receivedB = []
    const a = makeBroadcaster(socket)
    const b = makeBroadcaster(socket)

    a.init(data => receivedA.push(data))
    b.init(data => receivedB.push(data))
    assert.equal(await a.waitUntilReady({ timeoutMs: 1000 }), true)
    assert.equal(await b.waitUntilReady({ timeoutMs: 1000 }), true)

    const server = [a, b].find(instance => instance.isServer())
    assert.ok(server, 'expected one broadcaster to own the server')
    await server.closeServerForTest()

    await waitFor(() => a.isReady() && b.isReady(), { timeoutMs: 3000 })
    assert.equal(await b.broadcast({ id: 'after-reconnect' }, { timeoutMs: 1000 }), true)
    await waitFor(() => receivedA.length === 1 && receivedB.length === 1)

    await Promise.all([a.close(), b.close()])
    cleanupPath(socket)
  })

  it('waits for reconnect and flushes a queued broadcast', async () => {
    const socket = socketPath('queued')
    cleanupPath(socket)
    const receivedA = []
    const receivedB = []
    const a = makeBroadcaster(socket)
    const b = makeBroadcaster(socket)

    a.init(data => receivedA.push(data))
    b.init(data => receivedB.push(data))
    assert.equal(await a.waitUntilReady({ timeoutMs: 1000 }), true)
    assert.equal(await b.waitUntilReady({ timeoutMs: 1000 }), true)

    const server = [a, b].find(instance => instance.isServer())
    assert.ok(server, 'expected one broadcaster to own the server')
    await server.closeServerForTest()

    await waitFor(() => !b.isReady(), { timeoutMs: 1000 })
    const result = b.broadcast({ id: 'queued-during-reconnect' }, { timeoutMs: 2000 })
    assert.equal(await result, true)
    await waitFor(() => receivedA.length === 1 && receivedB.length === 1, { timeoutMs: 2000 })

    await Promise.all([a.close(), b.close()])
    cleanupPath(socket)
  })

  it('resolves false on shutdown or queue overflow', async () => {
    const shutdownSocket = socketPath('shutdown')
    cleanupPath(shutdownSocket)
    const stopped = makeBroadcaster(shutdownSocket)
    stopped.init(() => {})
    await stopped.close()
    assert.equal(await stopped.broadcast({ id: 'after-close' }, { timeoutMs: 20 }), false)
    cleanupPath(shutdownSocket)

    const overflowSocket = socketPath('overflow')
    cleanupPath(overflowSocket)
    fs.writeFileSync(overflowSocket, '')
    const capped = makeBroadcaster(overflowSocket, { maxQueue: 0, staleProbeTimeoutMs: 200, connectRetryMs: 200 })
    capped.init(() => {})
    assert.equal(await capped.broadcast({ id: 'overflow' }, { timeoutMs: 100 }), false)
    await capped.close()
    cleanupPath(overflowSocket)
  })
})
