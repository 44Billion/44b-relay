import { WebSocketServer } from 'ws'
import { addToCleanup } from '#helpers/process.js'
import { getIp } from '#helpers/request.js'
import { setTimer } from '#helpers/timer.js'

const wss = new WebSocketServer({
  noServer: true,
  // https://github.com/hoytech/strfry/blob/master/src/apps/relay/golpe.yaml#L39
  maxPayload: 131072 // 64 * 1024 // 8 * 1024 // 136 * 1024 // 8 kb note plus 128 kb data image
})
addToCleanup(() => wss.close())

const heartBeatInterval = setTimer(setInterval, function () {
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
  ws.addEventListener('message', ({ data }) => { console.log(`[RECV]: ${data.byteLength === undefined ? truncateWsMessage(data) : `${data.byteLength} Buffer bytes`}`) })
  ws.addEventListener('close', function () { console.log('disconnected', Object.keys(this.nostr.subscriptions).join(', ')) })
})

export function truncateWsMessage (data) {
  if (typeof data !== 'string') return data

  try {
    const json = JSON.parse(data)
    if (Array.isArray(json) && json[0] === 'EVENT' && typeof json[1] === 'object') {
      const event = json[1]

      if (typeof event.content === 'string' && event.content.length > 70) {
        event.content = `${event.content.slice(0, 70)}...(${event.content.length})`
      }

      if (typeof event.sig === 'string' && event.sig.length > 3) {
        event.sig = `${event.sig.slice(0, 3)}...(${event.sig.length})`
      }

      if (Array.isArray(event.tags)) {
        const totalTagsCount = event.tags.length
        event.tags = event.tags.slice(0, 5).map(tag =>
          Array.isArray(tag)
            ? tag.map(val => typeof val === 'string' && val.length > 64 ? `${val.slice(0, 64)}...(${val.length})` : val)
            : tag
        )

        if (totalTagsCount > 5) {
          event.tags.push(`... and ${totalTagsCount - 5} more tags`)
        }
      }

      return JSON.stringify([json[0], event])
    }
  } catch (err) {
    console.error('Error parsing WS message for truncation:', err)
  }

  return data.length > 140 ? `${data.slice(0, 140)}...(${data.length})` : data
}

wss.on('close', function () {
  clearInterval(heartBeatInterval)
  wss.clients.forEach(ws => { ws.close(1012, 'Service restart') })
})

export default wss
