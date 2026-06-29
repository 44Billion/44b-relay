import net from 'node:net'
import fs from 'node:fs'
import { addToCleanup } from '#helpers/process.js'

const SOCKET_PATH = '/tmp/44b-relay-ipc.sock'
const DEFAULT_BROADCAST_TIMEOUT_MS = 2000
const DEFAULT_CONNECT_RETRY_MS = 1000
const DEFAULT_STALE_PROBE_TIMEOUT_MS = 250
const DEFAULT_RECONNECT_FLUSH_DELAY_MS = 25
const DEFAULT_LOCK_STALE_MS = 5000
const DEFAULT_MAX_QUEUE = 500
const READY_MESSAGE = { __44bRelayIpcReady: true }
const READY_LINE = JSON.stringify(READY_MESSAGE)

function maybeUnref (timer) {
  timer?.unref?.()
  return timer
}

function noop () {}

function createBroadcaster ({
  socketPath = SOCKET_PATH,
  lockPath = `${socketPath}.lock`,
  connectRetryMs = DEFAULT_CONNECT_RETRY_MS,
  staleProbeTimeoutMs = DEFAULT_STALE_PROBE_TIMEOUT_MS,
  reconnectFlushDelayMs = DEFAULT_RECONNECT_FLUSH_DELAY_MS,
  lockStaleMs = DEFAULT_LOCK_STALE_MS,
  broadcastTimeoutMs = DEFAULT_BROADCAST_TIMEOUT_MS,
  maxQueue = DEFAULT_MAX_QUEUE,
  netModule = net,
  fsModule = fs,
  addCleanup = addToCleanup,
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => Date.now()
} = {}) {
  let connection = null
  let server = null
  let messageHandler = null
  let isServer = false
  let started = false
  let shuttingDown = false
  let connecting = false
  let connectionReady = false
  let serverStarting = false
  let reconnectTimer = null
  let flushTimer = null
  let cleanupRegistered = false

  const clients = new Set()
  const pendingBroadcasts = []
  const readyWaiters = new Set()
  const inFlightBySocket = new Map()

  function log (...args) {
    logger?.log?.(...args)
  }

  function warn (...args) {
    ;(logger?.warn || logger?.log)?.(...args)
  }

  function error (...args) {
    ;(logger?.error || logger?.log)?.(...args)
  }

  function warnUnexpected (err, message, expectedCodes = []) {
    if (expectedCodes.includes(err?.code)) return
    warn(message, err?.message ?? err)
  }

  function closeFd (fd, label) {
    try { fsModule.closeSync(fd) } catch (err) { warnUnexpected(err, `[IPC] Failed to close ${label}:`, ['EBADF']) }
  }

  function unlinkIfExists (path, label) {
    try { fsModule.unlinkSync(path) } catch (err) { warnUnexpected(err, `[IPC] Failed to unlink ${label}:`, ['ENOENT']) }
  }

  function unrefHandle (handle, label) {
    if (!handle?.unref) return
    try { handle.unref() } catch (err) { warnUnexpected(err, `[IPC] Failed to unref ${label}:`) }
  }

  function destroyHandle (handle, label) {
    if (!handle?.destroy) return
    try { handle.destroy() } catch (err) { warnUnexpected(err, `[IPC] Failed to destroy ${label}:`) }
  }

  function closeHandle (handle, label, done = noop) {
    if (!handle?.close) {
      done()
      return
    }
    try {
      handle.close(err => {
        if (err) warnUnexpected(err, `[IPC] Failed to close ${label}:`, ['ERR_SERVER_NOT_RUNNING'])
        done()
      })
    } catch (err) {
      warnUnexpected(err, `[IPC] Failed to close ${label}:`, ['ERR_SERVER_NOT_RUNNING'])
      done()
    }
  }

  function hasConnection () {
    return Boolean(connection && !connection.destroyed)
  }

  function isConnectionReady () {
    return Boolean(connectionReady && connection && !connection.destroyed && connection.writable)
  }

  function socketPathExists () {
    try { return fsModule.existsSync(socketPath) } catch (err) {
      warnUnexpected(err, '[IPC] Failed to inspect IPC socket path:')
      return false
    }
  }

  function settleReadyWaiters (value) {
    for (const waiter of readyWaiters) {
      clearTimeoutFn(waiter.timer)
      waiter.resolve(value)
    }
    readyWaiters.clear()
  }

  function settleBroadcast (item, value) {
    if (item.settled) return
    item.settled = true
    clearTimeoutFn(item.timer)
    item.resolve(value)
  }

  function deliverLocal (data) {
    queueMicrotask(() => {
      try {
        Promise.resolve(messageHandler?.(data)).catch(err => {
          error('[IPC] Local message handler failed:', err?.message ?? err)
        })
      } catch (err) {
        error('[IPC] Local message handler failed:', err?.message ?? err)
      }
    })
  }

  function trackInFlight (socket, item) {
    item.socket = socket
    let items = inFlightBySocket.get(socket)
    if (!items) {
      items = new Set()
      inFlightBySocket.set(socket, items)
    }
    items.add(item)
  }

  function untrackInFlight (socket, item) {
    const items = inFlightBySocket.get(socket)
    if (items) {
      items.delete(item)
      if (items.size === 0) inFlightBySocket.delete(socket)
    }
    if (item.socket === socket) item.socket = null
  }

  function requeueBroadcast (item, socket) {
    if (item.settled) return
    untrackInFlight(socket, item)
    if (connection === socket) {
      connection = null
      connectionReady = false
    }
    destroyHandle(socket, 'broadcast socket')
    if (now() > item.expiresAt || pendingBroadcasts.length >= maxQueue) {
      settleBroadcast(item, false)
      return
    }
    pendingBroadcasts.unshift(item)
    scheduleReconnect()
  }

  function requeueInFlight (socket) {
    const items = [...(inFlightBySocket.get(socket) || [])]
    for (const item of items) requeueBroadcast(item, socket)
  }

  function writeItem (item) {
    if (!isConnectionReady()) return false
    const socket = connection
    try {
      trackInFlight(socket, item)
      socket.write(item.line + '\n', err => {
        if (item.socket !== socket) return
        untrackInFlight(socket, item)
        if (err) {
          requeueBroadcast(item, socket)
          return
        }
        deliverLocal(item.data)
        settleBroadcast(item, true)
      })
      return true
    } catch (err) {
      error('[IPC] Broadcast write failed:', err?.message ?? err)
      requeueBroadcast(item, socket)
      return true
    }
  }

  function flushQueue () {
    if (!isConnectionReady()) return
    while (pendingBroadcasts.length && isConnectionReady()) {
      const item = pendingBroadcasts.shift()
      if (item.settled) continue
      if (now() > item.expiresAt) {
        settleBroadcast(item, false)
        continue
      }
      if (!writeItem(item)) {
        pendingBroadcasts.unshift(item)
        return
      }
    }
  }

  function rejectPendingBroadcasts () {
    while (pendingBroadcasts.length) settleBroadcast(pendingBroadcasts.shift(), false)
  }

  function scheduleQueueFlush () {
    if (!pendingBroadcasts.length || flushTimer) return
    flushTimer = maybeUnref(setTimeoutFn(() => {
      flushTimer = null
      flushQueue()
    }, reconnectFlushDelayMs))
  }

  function ensureConnectionAttempt () {
    if (shuttingDown || isConnectionReady() || hasConnection() || connecting || serverStarting) return
    if (server || socketPathExists()) connectToServer()
    else tryCreateServer()
  }

  function scheduleReconnect () {
    if (shuttingDown || reconnectTimer) return
    reconnectTimer = maybeUnref(setTimeoutFn(() => {
      reconnectTimer = null
      ensureConnectionAttempt()
    }, connectRetryMs))
  }

  function releaseLock (fd) {
    if (fd === null || fd === undefined) return
    closeFd(fd, 'recovery lock')
    unlinkIfExists(lockPath, 'recovery lock')
  }

  function tryOpenRecoveryLock () {
    try {
      return fsModule.openSync(lockPath, 'wx')
    } catch (err) {
      if (err?.code === 'EEXIST') return null
      warnUnexpected(err, '[IPC] Failed to open recovery lock:', ['ENOENT'])
      return null
    }
  }

  function acquireRecoveryLock () {
    const fd = tryOpenRecoveryLock()
    if (fd !== null && fd !== undefined) return fd

    let stat
    try {
      stat = fsModule.statSync(lockPath)
    } catch (err) {
      warnUnexpected(err, '[IPC] Failed to stat recovery lock:', ['ENOENT'])
      return tryOpenRecoveryLock()
    }

    if (now() - stat.mtimeMs <= lockStaleMs) return null
    unlinkIfExists(lockPath, 'stale recovery lock')
    return tryOpenRecoveryLock()
  }

  function probeSocket () {
    return new Promise(resolve => {
      let settled = false
      const socket = netModule.createConnection(socketPath)
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeoutFn(timer)
        destroyHandle(socket, 'probe socket')
        resolve(value)
      }
      const timer = maybeUnref(setTimeoutFn(() => finish(false), staleProbeTimeoutMs))
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
    })
  }

  async function recoverStaleSocket () {
    if (shuttingDown) return
    const fd = acquireRecoveryLock()
    if (fd === null || fd === undefined) {
      scheduleReconnect()
      return
    }

    try {
      const isAlive = await probeSocket()
      if (shuttingDown) return
      if (isAlive) {
        connectToServer()
        return
      }
      unlinkIfExists(socketPath, 'IPC socket')
      tryCreateServer()
    } finally {
      releaseLock(fd)
    }
  }

  function parseLines (chunk, state, onLine) {
    state.buffer += chunk.toString()
    const lines = state.buffer.split('\n')
    state.buffer = lines.pop()
    for (const line of lines) {
      if (line) onLine(line)
    }
  }

  function handleClientConnection (clientSocket) {
    clients.add(clientSocket)
    log(`[IPC] Client connected (total: ${clients.size})`)
    clientSocket.write(READY_LINE + '\n')

    const state = { buffer: '' }
    clientSocket.on('data', chunk => {
      parseLines(chunk, state, line => {
        for (const other of clients) {
          if (other !== clientSocket && !other.destroyed && other.writable) other.write(line + '\n')
        }
      })
    })

    clientSocket.on('close', () => {
      clients.delete(clientSocket)
      log(`[IPC] Client disconnected (total: ${clients.size})`)
    })

    clientSocket.on('error', err => {
      clients.delete(clientSocket)
      warn('[IPC] Client socket error:', err?.message ?? err)
    })
  }

  function registerCleanup () {
    if (cleanupRegistered) return
    cleanupRegistered = true
    addCleanup(() => close())
  }

  function closeServer (currentServer, { unlinkSocket = false } = {}) {
    return new Promise(resolve => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeoutFn(timer)
        if (unlinkSocket) {
          unlinkIfExists(socketPath, 'IPC socket')
        }
        resolve()
      }
      const timer = setTimeoutFn(done, 250)
      closeHandle(currentServer, 'IPC server', done)
    })
  }

  function tryCreateServer () {
    if (shuttingDown || server || serverStarting) return
    serverStarting = true
    const candidate = netModule.createServer(handleClientConnection)

    candidate.on('error', err => {
      serverStarting = false
      if (shuttingDown) return
      if (err?.code === 'EADDRINUSE') {
        closeHandle(candidate, 'candidate IPC server')
        connectToServer()
        return
      }
      error('[IPC] Server error:', err?.message ?? err)
      scheduleReconnect()
    })

    candidate.listen(socketPath, () => {
      serverStarting = false
      if (shuttingDown) {
        unrefHandle(candidate, 'candidate IPC server')
        closeHandle(candidate, 'candidate IPC server')
        unlinkIfExists(socketPath, 'IPC socket')
        return
      }
      server = candidate
      isServer = true
      log(`[IPC] Server listening on ${socketPath} (pid: ${process.pid})`)
      registerCleanup()
      connectToServer()
    })
  }

  function connectToServer () {
    if (shuttingDown || connecting || hasConnection()) return
    connecting = true

    const client = netModule.createConnection(socketPath)
    let connected = false
    const state = { buffer: '' }

    client.on('connect', () => {
      connected = true
      connecting = false
      if (shuttingDown) {
        unrefHandle(client, 'IPC client')
        destroyHandle(client, 'IPC client')
        return
      }
      connection = client
      connectionReady = false
      log(`[IPC] Connected to server (pid: ${process.pid})`)
    })

    client.on('data', chunk => {
      parseLines(chunk, state, line => {
        try {
          const data = JSON.parse(line)
          if (data?.__44bRelayIpcReady === true && Object.keys(data).length === 1) {
            connectionReady = true
            settleReadyWaiters(true)
            scheduleQueueFlush()
            return
          }
          messageHandler?.(data)
        } catch (err) {
          error('[IPC] Failed to parse message:', err?.message ?? err)
        }
      })
    })

    client.on('close', () => {
      requeueInFlight(client)
      if (connection === client) {
        connection = null
        connectionReady = false
      }
      connecting = false
      if (!shuttingDown) {
        log('[IPC] Disconnected from server, reconnecting soon...')
        scheduleReconnect()
      }
    })

    client.on('error', err => {
      requeueInFlight(client)
      if (connection === client) {
        connection = null
        connectionReady = false
      }
      connecting = false
      const code = err?.code
      if (!connected && (code === 'ECONNREFUSED' || code === 'ENOENT')) {
        recoverStaleSocket().catch(err => error('[IPC] Socket recovery failed:', err?.message ?? err))
      } else {
        warn('[IPC] Connection error:', err?.message ?? err)
        scheduleReconnect()
      }
    })
  }

  function init (onMessage = noop) {
    if (started) {
      messageHandler = onMessage
      return
    }
    started = true
    shuttingDown = false
    messageHandler = onMessage
    tryCreateServer()
  }

  function waitUntilReady ({ timeoutMs = broadcastTimeoutMs } = {}) {
    if (isConnectionReady()) return Promise.resolve(true)
    if (!started || shuttingDown) return Promise.resolve(false)
    ensureConnectionAttempt()
    return new Promise(resolve => {
      const waiter = { resolve, timer: null }
      waiter.timer = maybeUnref(setTimeoutFn(() => {
        readyWaiters.delete(waiter)
        resolve(false)
      }, timeoutMs))
      readyWaiters.add(waiter)
    })
  }

  function broadcast (data, { timeoutMs = broadcastTimeoutMs } = {}) {
    if (!started || shuttingDown) return Promise.resolve(false)

    let line
    try {
      line = JSON.stringify(data)
    } catch (err) {
      error('[IPC] Could not serialize broadcast:', err?.message ?? err)
      return Promise.resolve(false)
    }

    return new Promise(resolve => {
      const item = {
        data,
        line,
        resolve,
        settled: false,
        expiresAt: now() + timeoutMs,
        timer: null
      }
      item.timer = maybeUnref(setTimeoutFn(() => {
        const idx = pendingBroadcasts.indexOf(item)
        if (idx >= 0) pendingBroadcasts.splice(idx, 1)
        settleBroadcast(item, false)
      }, timeoutMs))

      if (isConnectionReady()) {
        writeItem(item)
        return
      }

      if (pendingBroadcasts.length >= maxQueue) {
        settleBroadcast(item, false)
        return
      }

      pendingBroadcasts.push(item)
      ensureConnectionAttempt()
    })
  }

  function close () {
    shuttingDown = true
    started = false
    clearTimeoutFn(reconnectTimer)
    reconnectTimer = null
    clearTimeoutFn(flushTimer)
    flushTimer = null
    settleReadyWaiters(false)
    rejectPendingBroadcasts()
    for (const items of inFlightBySocket.values()) {
      for (const item of items) settleBroadcast(item, false)
    }
    inFlightBySocket.clear()

    for (const client of clients) {
      unrefHandle(client, 'IPC client')
      destroyHandle(client, 'IPC client')
    }
    clients.clear()

    unrefHandle(connection, 'IPC connection')
    destroyHandle(connection, 'IPC connection')
    connection = null
    connectionReady = false
    connecting = false

    const currentServer = server
    server = null
    serverStarting = false
    const wasServer = isServer
    isServer = false

    if (!currentServer) {
      if (wasServer) {
        unlinkIfExists(socketPath, 'IPC socket')
      }
      return Promise.resolve()
    }

    unrefHandle(currentServer, 'IPC server')
    closeHandle(currentServer, 'IPC server')
    if (wasServer) {
      unlinkIfExists(socketPath, 'IPC socket')
    }
    return Promise.resolve()
  }

  async function closeServerForTest () {
    const currentServer = server
    if (!currentServer) return
    server = null
    isServer = false
    destroyHandle(connection, 'IPC connection')
    connection = null
    connectionReady = false
    connecting = false
    for (const client of clients) {
      destroyHandle(client, 'IPC client')
    }
    clients.clear()
    await closeServer(currentServer, { unlinkSocket: true })
    scheduleReconnect()
  }

  return {
    init,
    broadcast,
    waitUntilReady,
    isReady: isConnectionReady,
    isServer: () => isServer,
    close,
    closeServerForTest
  }
}

const defaultBroadcaster = createBroadcaster()

function init (onMessage) {
  if (process.env.NODE_ENV === 'test') return
  defaultBroadcaster.init(onMessage)
}

function broadcast (data, options) {
  return defaultBroadcaster.broadcast(data, options)
}

function waitUntilReady (options) {
  return defaultBroadcaster.waitUntilReady(options)
}

function isReady () {
  return defaultBroadcaster.isReady()
}

export { init, broadcast, waitUntilReady, isReady, createBroadcaster }
