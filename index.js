import '#config/dotenv.js'
// import { parse } from 'node:url'
import { getIp } from '#helpers/request.js'
import server from '#services/servers/http-server.js'
import wss from '#services/servers/web-socket-server.js'
import Relay from '#services/relay/index.js'
import {
  rateLimitReqByIp,
  returnReqToIpRateLimitPool,
  returnReqToPubkeyRateLimitPool,
  disconnectIfNotAuthenticatedAfterSomeTime
} from '#services/rate-limiting/web-socket-request-limiter.js'
import { rateLimitReqByIp as serverRateLimitReqByIp } from '#services/rate-limiting/server-request-limiter.js'

server.on('upgrade', (req, socket, upgradeHead) => {
  logReqRes(req, socket)
  if (req.headers.upgrade !== 'websocket') return socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n', 'ascii')

  req.ip = getIp(req)
  let { isRateLimited } = serverRateLimitReqByIp(req)
  if (!isRateLimited) ({ isRateLimited } = rateLimitReqByIp(req))
  if (isRateLimited) return socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n', 'ascii')

  // Could implement authentication here through `authorization` query param
  // although it wouldn't support many users on same connection
  // https://github.com/nostr-protocol/nips/pull/571
  // const parsedUrl = parse(req.url, true)
  // if (parsedUrl.query.authorization ...) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n', 'ascii')
  wss.handleUpgrade(req, socket, upgradeHead, function done (ws) {
    wss.emit('connection', ws, req)
  })
})

const relay = new Relay({ wss })
wss.on('connection', (ws, req) => {
  disconnectIfNotAuthenticatedAfterSomeTime(ws)
  // close is also emitted when calling ws.terminate() - https://github.com/websockets/ws/issues/1142#issuecomment-463630085
  ws.on('close', () => {
    returnReqToIpRateLimitPool(req)
    returnReqToPubkeyRateLimitPool(ws)
  })
  relay.handleConnection(ws, req)
})

function logReqRes (req, res) {
  console.log(`${req.method} ${req.url} (fwd: ${req.headers['x-forwarded-for']} - sckt: ${req.socket.remoteAddress})`)
  req.on('error', err => { console.error(`(Websocket) Request error: ${err.stack}`) })
  res.on('error', err => { console.error(`(Websocket) Socket error: ${err.stack}`) })
}
