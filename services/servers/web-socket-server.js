import { WebSocketServer } from 'ws'
import { addToCleanup } from '#helpers/process.js'
import { getIp } from '#helpers/request.js'

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024 // 8 * 1024 // 136 * 1024 // 8 kb note plus 128 kb data image
})
addToCleanup(() => wss.close())

const heartBeatInterval = setInterval(function () {
  wss.clients.forEach(function (ws) {
    if (ws.isAlive === false) return ws.terminate()

    ws.isAlive = false
    ws.ping() // Pong messages are automatically sent in response to ping messages as required by the spec
  })
}, 30000)

wss.on('connection', (ws, req) => {
  ws.ip = getIp(req)
  ws.isAlive = true

  ws.addEventListener('pong', function heartbeat () { this.isAlive = true })
  ws.addEventListener('error', error => { console.error(`Oops! Received this error: ${error}`) })
  ws.addEventListener('message', data => { console.log(`[RECV]: ${data}`) })
  ws.addEventListener('close', function () { console.log('disconnected', Object.keys(this.nostr.subscriptions).join(', ')) })
})

wss.on('close', function () {
  clearInterval(heartBeatInterval)
  wss.clients.forEach(ws => { ws.close(1012, 'Service restart') })
})

export default wss
