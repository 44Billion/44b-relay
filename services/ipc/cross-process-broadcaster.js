import net from 'node:net'
import fs from 'node:fs'
import { addToCleanup } from '#helpers/process.js'

const SOCKET_PATH = '/tmp/44b-relay-ipc.sock'

let connection = null // net.Socket used to send messages
let messageHandler = null // function(data) callback
let isServer = false
const clients = new Set() // server-side: connected client sockets

/**
 * Initialize the IPC broadcaster.
 * First process to start becomes the UDS server; others connect as clients.
 * @param {function} onMessage — called with parsed data when a message arrives from another process
 */
function init (onMessage) {
  if (process.env.NODE_ENV === 'test') return
  messageHandler = onMessage
  tryCreateServer()
}

function tryCreateServer () {
  const server = net.createServer(handleClientConnection)

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Another process may already be the server — try connecting as client
      tryConnectAsClient()
    } else {
      console.error('[IPC] Server error:', err)
    }
  })

  server.listen(SOCKET_PATH, () => {
    isServer = true
    console.log(`[IPC] Server listening on ${SOCKET_PATH} (pid: ${process.pid})`)

    addToCleanup(() => {
      server.close()
      try { fs.unlinkSync(SOCKET_PATH) } catch {}
    })

    // Connect to our own server so broadcast() works uniformly
    connectToServer()
  })
}

function handleClientConnection (clientSocket) {
  clients.add(clientSocket)
  console.log(`[IPC] Client connected (total: ${clients.size})`)

  let buffer = ''
  clientSocket.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    // Last element is either '' (complete message) or a partial message
    buffer = lines.pop()

    for (const line of lines) {
      if (!line) continue
      // Relay to all OTHER connected clients
      for (const other of clients) {
        if (other !== clientSocket && !other.destroyed) {
          other.write(line + '\n')
        }
      }
    }
  })

  clientSocket.on('close', () => {
    clients.delete(clientSocket)
    console.log(`[IPC] Client disconnected (total: ${clients.size})`)
  })

  clientSocket.on('error', (err) => {
    console.error('[IPC] Client socket error:', err.message)
    clients.delete(clientSocket)
  })
}

function connectToServer () {
  const client = net.createConnection(SOCKET_PATH)

  client.on('connect', () => {
    connection = client
    console.log(`[IPC] Connected to server (pid: ${process.pid})`)
  })

  let buffer = ''
  client.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop()

    for (const line of lines) {
      if (!line) continue
      try {
        const data = JSON.parse(line)
        messageHandler?.(data)
      } catch (err) {
        console.error('[IPC] Failed to parse message:', err.message)
      }
    }
  })

  client.on('close', () => {
    connection = null
    if (!isServer) {
      // Reconnect with backoff
      console.log('[IPC] Disconnected from server, reconnecting in 1s...')
      setTimeout(() => tryConnectAsClient(), 1000)
    }
  })

  client.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
      // Stale socket file — remove and become server
      console.log('[IPC] Stale socket detected, taking over as server...')
      try { fs.unlinkSync(SOCKET_PATH) } catch {}
      tryCreateServer()
    } else {
      console.error('[IPC] Connection error:', err.message)
    }
  })
}

function tryConnectAsClient () {
  connectToServer()
}

/**
 * Broadcast data to all other processes.
 * @param {object} data — must be JSON-serializable
 */
function broadcast (data) {
  if (!connection || connection.destroyed) return
  connection.write(JSON.stringify(data) + '\n')
}

export { init, broadcast }
