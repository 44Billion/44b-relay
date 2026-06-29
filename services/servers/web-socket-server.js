import { WebSocketServer } from 'ws'
import zlib from 'node:zlib'
import { addToCleanup } from '#helpers/process.js'
import { getIp } from '#helpers/request.js'
import { setTimer } from '#helpers/timer.js'

const wss = new WebSocketServer({
  noServer: true,
  // https://github.com/hoytech/strfry/blob/b80cda3a812af1b662223edad47eb70b053508b6/src/apps/relay/golpe.yaml#L58
  // Messages over this size produce an error event on the ws instance
  // 1024*1024 (1 Mebibyte) plus an extra (max payload must be bigger than the max event size) may be good for follow lists
  maxPayload: 131072, // 512 * 1024 // 64 * 1024 // 8 * 1024 // 136 * 1024 // 8 kb note plus 128 kb data image
  perMessageDeflate: {
    zlibDeflateOptions: {
      // Use best speed (level 1) which gives ~73% reduction with large window
      // avoiding the CPU cost of default level 6
      level: zlib.constants.Z_BEST_SPEED,
      memLevel: 9 // Use more memory for internal state to improve speed/ratio
    },
    // Use default window size (15) for best compression ratio.
    threshold: 1024,
    // Critical for high concurrency: disable context takeover.
    // Without this, each connection holds ~300KB of memory for compression context.
    // With 10k connections, that's 3GB RAM. Disabling it clears memory between messages.
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    // The number of concurrent calls to zlib. Calls above this limit will be queued.
    // This confirms compression is ASYNC and limited to avoid blocking the event loop or overloading the thread pool.
    // Default is 10.
    concurrencyLimit: 10
  }
})
addToCleanup(() => wss.close())

const heartBeatInterval = setTimer(setInterval, function () {
  wss.clients.forEach(function (ws) {
    if (ws.isAlive === false) {
      console.log('Terminating dead connection', ws.ip)
      return ws.terminate()
    }

    ws.isAlive = false
    ws.ping() // Pong messages are automatically sent in response to ping messages as required by the spec
  })
}, 30000)

// The close code and reason are set by the other peer via a close frame
// When not using custom close codes, anything different from 1000 or 1005
// indicates that connection was not cleanly closed.
// https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.1
function wasClean (code) {
  return code === undefined || code === 1000 || code === 1005 // || (code >= 3000 && code <= 4999)
}
wss.on('connection', (ws, req) => {
  ws.ip = getIp(req)
  ws.isAlive = true

  ws.addEventListener('pong', function heartbeat () { this.isAlive = true })
  ws.addEventListener('error', error => { console.error('Oops! Received this error:', error) })
  ws.addEventListener('message', ({ data }) => {
    ws.isAlive = true
    console.log(`[RECV]: ${data.byteLength === undefined ? truncateWsMessage(data) : `${data.byteLength} Buffer bytes`}`)
  })
  ws.addEventListener('close', function ({ code, reason }) {
    console.log(`disconnected (${wasClean(code) ? 'clean' : 'unclean'})- code:${code}, reason: ${reason || '<none>'
    }, subs: ${Object.keys(this.nostr.subscriptions).join(', ') || '<none>'}`)
  })
})

export function truncateWsMessage (data) {
  if (typeof data !== 'string') return data

  let json
  try {
    json = JSON.parse(data)
  } catch {
    return data.length > 140 ? `${data.slice(0, 140)}...(${data.length})` : data
  }

  try {
    if (Array.isArray(json) && ['EVENT', 'AUTH'].includes(json[0]) && typeof json[1] === 'object') {
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
    if (process.env.NODE_ENV === 'test') throw err
    console.error('Error parsing WS message for truncation:', err)
  }

  return data.length > 140 ? `${data.slice(0, 140)}...(${data.length})` : data
}

wss.on('close', function () {
  clearInterval(heartBeatInterval)
  wss.clients.forEach(ws => { ws.close(1012, 'Service restart') })
})

export default wss
