import '#config/dotenv.js'
// import { parse } from 'node:url'
import { getIp } from '#helpers/request.js'
import server from '#services/servers/http-server.js'
import wss from '#services/servers/web-socket-server.js'
import Relay from '#services/relay/index.js'
import {
  rateLimitReqByIp,
  returnReqToIpRateLimitPool,
  returnReqToPubkeyRateLimitPool
  // disconnectIfNotAuthenticatedAfterSomeTime
} from '#services/rate-limiting/web-socket-request-limiter.js'
import { rateLimitReqByIp as serverRateLimitReqByIp } from '#services/rate-limiting/server-request-limiter.js'
import { init as initBroadcaster } from '#services/ipc/cross-process-broadcaster.js'
import { sendToClientsWithAMatchingFilter } from '#services/relay/nostr-message-handler/event-handler.js'
import { parseNip50PathExtensions } from '#helpers/subscription.js'

export function handleHttpServerUpgrade (req, socket, upgradeHead) {
  logReqRes(req, socket)
  if (req.headers.upgrade !== 'websocket') return socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n', 'ascii')

  req.ip ??= getIp(req)
  let { isRateLimited } = serverRateLimitReqByIp(req)
  if (!isRateLimited) ({ isRateLimited } = rateLimitReqByIp(req))
  if (isRateLimited) return socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n', 'ascii')

  // Parse NIP-50 path extensions from /.well-known/nip50/<ext>/...
  const pathname = req.webUrl?.pathname /* from production: req.webUrl = new URL(...) */ ?? (req.url?.split('?')[0] || '/')
  const pathExtensions = parseNip50PathExtensions(pathname)
  if (pathname !== '/' && !pathExtensions) return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n', 'ascii')

  req.nip50PathExtensions = pathExtensions

  // Could implement authentication here through `authorization` query param
  // although it wouldn't support many users on same connection
  // https://github.com/nostr-protocol/nips/pull/571
  // const parsedUrl = parse(req.url, true)
  // if (parsedUrl.query.authorization ...) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n', 'ascii')
  wss.handleUpgrade(req, socket, upgradeHead, function done (ws) {
    wss.emit('connection', ws, req)
  })
}

const relay = new Relay({ wss })
export function handleWebSocketServerConnection (ws, req) {
  // AUTH isn't required anymore
  // disconnectIfNotAuthenticatedAfterSomeTime(ws)
  // close is also emitted when calling ws.terminate() - https://github.com/websockets/ws/issues/1142#issuecomment-463630085
  ws.on('close', () => {
    returnReqToIpRateLimitPool(req)
    returnReqToPubkeyRateLimitPool(ws)
  })
  relay.handleConnection(ws, req)
}
wss.on('connection', handleWebSocketServerConnection)

function logReqRes (req, res) {
  console.log(`${req.method} ${req.url} (fwd: ${req.headers['x-forwarded-for']} - sckt: ${req.socket.remoteAddress})`)
  req.on('error', err => { console.error(`(Websocket) Request error: ${err.stack}`) })
  res.on('error', err => { console.error(`(Websocket) Socket error: ${err.stack}`) })
}

const shouldSpinUpServer = process.env.NODE_ENV === 'development' || process.env.SHOULD_SPIN_UP_SERVER === 'true'
if (shouldSpinUpServer) {
  server.on('upgrade', handleHttpServerUpgrade)
}

initBroadcaster(({ event, eventLanguage, eventTopics }) => {
  sendToClientsWithAMatchingFilter({ wss, event, eventLanguage, eventTopics })
})

const shouldStartWorker = process.env.NODE_ENV !== 'test'
if (shouldStartWorker) {
  await (await import('#models/job/worker.js')).init()
}
