import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'

// Mock addToCleanup so it doesn't register real cleanup handlers
mock.module('#helpers/process.js', {
  namedExports: {
    addToCleanup: mock.fn()
  }
})

// We import fresh each test via dynamic import to reset module state
// But since module caching makes this tricky, we test the UDS protocol directly

const TEST_SOCKET_PATH = '/tmp/44b-relay-ipc-test.sock'

function cleanup () {
  try { fs.unlinkSync(TEST_SOCKET_PATH) } catch {}
}

describe('cross-process-broadcaster', () => {
  afterEach(() => {
    cleanup()
  })

  describe('UDS protocol (direct socket tests)', () => {
    it('should relay newline-delimited JSON between two clients via a server', async () => {
      cleanup()
      const received = []

      const server = net.createServer((clientSocket) => {
        const clients = server._testClients ??= new Set()
        clients.add(clientSocket)

        let buffer = ''
        clientSocket.on('data', (chunk) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop()

          for (const line of lines) {
            if (!line) continue
            for (const other of clients) {
              if (other !== clientSocket && !other.destroyed) {
                other.write(line + '\n')
              }
            }
          }
        })

        clientSocket.on('close', () => clients.delete(clientSocket))
      })

      await new Promise((resolve, reject) => {
        server.listen(TEST_SOCKET_PATH, resolve)
        server.on('error', reject)
      })

      // Connect client A (sender)
      const clientA = net.createConnection(TEST_SOCKET_PATH)
      await new Promise((resolve) => clientA.on('connect', resolve))

      // Connect client B (receiver)
      const clientB = net.createConnection(TEST_SOCKET_PATH)
      await new Promise((resolve) => clientB.on('connect', resolve))

      let bufferB = ''
      clientB.on('data', (chunk) => {
        bufferB += chunk.toString()
        const lines = bufferB.split('\n')
        bufferB = lines.pop()
        for (const line of lines) {
          if (!line) continue
          received.push(JSON.parse(line))
        }
      })

      // Send from A
      const testData = { event: { id: 'test1', kind: 1 }, eventLanguage: 'en' }
      clientA.write(JSON.stringify(testData) + '\n')

      // Wait for delivery
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(received.length, 1)
      assert.deepEqual(received[0], testData)

      // Sender (A) should NOT receive its own message
      const receivedByA = []
      let bufferA = ''
      clientA.on('data', (chunk) => {
        bufferA += chunk.toString()
        const lines = bufferA.split('\n')
        bufferA = lines.pop()
        for (const line of lines) {
          if (!line) continue
          receivedByA.push(JSON.parse(line))
        }
      })

      // Send another message from A
      clientA.write(JSON.stringify({ event: { id: 'test2' } }) + '\n')
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(receivedByA.length, 0, 'Sender should not receive its own message')
      assert.equal(received.length, 2, 'Receiver should get the second message')

      // Cleanup
      clientA.destroy()
      clientB.destroy()
      server.close()
    })

    it('should handle multiple messages in a single chunk', async () => {
      cleanup()
      const received = []

      const server = net.createServer((clientSocket) => {
        const clients = server._testClients ??= new Set()
        clients.add(clientSocket)

        let buffer = ''
        clientSocket.on('data', (chunk) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop()

          for (const line of lines) {
            if (!line) continue
            for (const other of clients) {
              if (other !== clientSocket && !other.destroyed) {
                other.write(line + '\n')
              }
            }
          }
        })

        clientSocket.on('close', () => clients.delete(clientSocket))
      })

      await new Promise((resolve, reject) => {
        server.listen(TEST_SOCKET_PATH, resolve)
        server.on('error', reject)
      })

      const clientA = net.createConnection(TEST_SOCKET_PATH)
      await new Promise((resolve) => clientA.on('connect', resolve))

      const clientB = net.createConnection(TEST_SOCKET_PATH)
      await new Promise((resolve) => clientB.on('connect', resolve))

      let bufferB = ''
      clientB.on('data', (chunk) => {
        bufferB += chunk.toString()
        const lines = bufferB.split('\n')
        bufferB = lines.pop()
        for (const line of lines) {
          if (!line) continue
          received.push(JSON.parse(line))
        }
      })

      // Send multiple messages in a single write (batched)
      const msg1 = JSON.stringify({ id: 1 })
      const msg2 = JSON.stringify({ id: 2 })
      const msg3 = JSON.stringify({ id: 3 })
      clientA.write(msg1 + '\n' + msg2 + '\n' + msg3 + '\n')

      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(received.length, 3)
      assert.deepEqual(received[0], { id: 1 })
      assert.deepEqual(received[1], { id: 2 })
      assert.deepEqual(received[2], { id: 3 })

      clientA.destroy()
      clientB.destroy()
      server.close()
    })

    it('should handle partial messages split across chunks', async () => {
      cleanup()
      const received = []

      const server = net.createServer((clientSocket) => {
        const clients = server._testClients ??= new Set()
        clients.add(clientSocket)

        let buffer = ''
        clientSocket.on('data', (chunk) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop()

          for (const line of lines) {
            if (!line) continue
            for (const other of clients) {
              if (other !== clientSocket && !other.destroyed) {
                other.write(line + '\n')
              }
            }
          }
        })

        clientSocket.on('close', () => clients.delete(clientSocket))
      })

      await new Promise((resolve, reject) => {
        server.listen(TEST_SOCKET_PATH, resolve)
        server.on('error', reject)
      })

      const clientA = net.createConnection(TEST_SOCKET_PATH)
      await new Promise((resolve) => clientA.on('connect', resolve))

      const clientB = net.createConnection(TEST_SOCKET_PATH)
      await new Promise((resolve) => clientB.on('connect', resolve))

      let bufferB = ''
      clientB.on('data', (chunk) => {
        bufferB += chunk.toString()
        const lines = bufferB.split('\n')
        bufferB = lines.pop()
        for (const line of lines) {
          if (!line) continue
          received.push(JSON.parse(line))
        }
      })

      // Send a partial message
      const fullMsg = JSON.stringify({ event: { id: 'partial_test' } })
      const half1 = fullMsg.slice(0, Math.floor(fullMsg.length / 2))
      const half2 = fullMsg.slice(Math.floor(fullMsg.length / 2))

      clientA.write(half1)
      await new Promise((resolve) => setTimeout(resolve, 30))

      // Should not have received anything yet
      assert.equal(received.length, 0, 'Should not parse partial message')

      // Send the rest + newline
      clientA.write(half2 + '\n')
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(received.length, 1)
      assert.deepEqual(received[0], { event: { id: 'partial_test' } })

      clientA.destroy()
      clientB.destroy()
      server.close()
    })

    it('should not relay message back to the sender', async () => {
      cleanup()
      const receivedByA = []
      const receivedByB = []

      const server = net.createServer((clientSocket) => {
        const clients = server._testClients ??= new Set()
        clients.add(clientSocket)

        let buffer = ''
        clientSocket.on('data', (chunk) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop()

          for (const line of lines) {
            if (!line) continue
            for (const other of clients) {
              if (other !== clientSocket && !other.destroyed) {
                other.write(line + '\n')
              }
            }
          }
        })

        clientSocket.on('close', () => clients.delete(clientSocket))
      })

      await new Promise((resolve, reject) => {
        server.listen(TEST_SOCKET_PATH, resolve)
        server.on('error', reject)
      })

      const clientA = net.createConnection(TEST_SOCKET_PATH)
      await new Promise((resolve) => clientA.on('connect', resolve))

      const clientB = net.createConnection(TEST_SOCKET_PATH)
      await new Promise((resolve) => clientB.on('connect', resolve))

      let bufA = ''
      clientA.on('data', (chunk) => {
        bufA += chunk.toString()
        const lines = bufA.split('\n')
        bufA = lines.pop()
        for (const line of lines) {
          if (!line) continue
          receivedByA.push(JSON.parse(line))
        }
      })

      let bufB = ''
      clientB.on('data', (chunk) => {
        bufB += chunk.toString()
        const lines = bufB.split('\n')
        bufB = lines.pop()
        for (const line of lines) {
          if (!line) continue
          receivedByB.push(JSON.parse(line))
        }
      })

      // A sends
      clientA.write(JSON.stringify({ from: 'A' }) + '\n')
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(receivedByA.length, 0, 'A should not receive its own message')
      assert.equal(receivedByB.length, 1, 'B should receive the message')
      assert.deepEqual(receivedByB[0], { from: 'A' })

      // B sends
      clientB.write(JSON.stringify({ from: 'B' }) + '\n')
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(receivedByB.length, 1, 'B should not receive its own message')
      assert.equal(receivedByA.length, 1, 'A should receive B\'s message')
      assert.deepEqual(receivedByA[0], { from: 'B' })

      clientA.destroy()
      clientB.destroy()
      server.close()
    })
  })

  describe('init and broadcast (module-level)', () => {
    it('should skip initialization in test mode', async () => {
      // The module checks NODE_ENV === 'test' and returns early
      // Since we're in test mode, importing and calling init should be a no-op
      const { init, broadcast } = await import('#services/ipc/cross-process-broadcaster.js')

      // Should not throw
      init(() => {})

      // broadcast should be a no-op (no connection)
      broadcast({ event: { id: 'test' } })
    })
  })
})
