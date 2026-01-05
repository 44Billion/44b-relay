import { rateLimitByKey, getIp } from '#helpers/request.js'
import { isAuthenticated } from '#services/relay/authenticator.js'

// 1. 30 open reqs per ip - considering many users with same ip
// 2. 10 new reqs per 5 seconds - considering users opening new tabs
// 2. 3 new reqs per second - considering 3 users at same second
const MAX_OPEN_CONNECTIONS = 30
const openConnectionsByIp = {}

function rateLimitReqByIp (req) {
  const ip = getIp(req)
  openConnectionsByIp[ip] ??= 0
  let isRateLimited = openConnectionsByIp[ip] === MAX_OPEN_CONNECTIONS
  if (isRateLimited) return { isRateLimited }

  openConnectionsByIp[ip]++
  ;({ isRateLimited } = rateLimitByKey({ key: 'webSocket::' + ip + '::a', reqsPerWindow: 10, windowSeconds: 5 }))
  if (isRateLimited) return { isRateLimited }

  ;({ isRateLimited } = rateLimitByKey({ key: 'webSocket::' + ip + '::b', reqsPerWindow: 3, windowSeconds: 1 }))
  return { isRateLimited }
}

function returnReqToIpRateLimitPool (req) {
  const ip = getIp(req)

  openConnectionsByIp[ip]--
  if (openConnectionsByIp[ip] === 0) delete openConnectionsByIp[ip]
}

// 15 open reqs by pubkey - 15 tabs
// remember to disconnect if not authenticated in x seconds to honor this
const MAX_OPEN_CONNECTIONS_PER_PUBKEY = 15
const openConnectionsByPubkey = {}
function rateLimitReqByPubkey (ws) {
  const { pubkey } = ws.nostr

  openConnectionsByPubkey[pubkey] ??= 0
  const isRateLimited = openConnectionsByPubkey[pubkey] === MAX_OPEN_CONNECTIONS_PER_PUBKEY
  if (!isRateLimited) openConnectionsByPubkey[pubkey]++

  return { isRateLimited }
}

function disconnectIfNotAuthenticatedAfterSomeTime (ws) {
  setTimeout(() => {
    if (isAuthenticated({ ws })) return
    ws.close(1000, 'Didn\'t authenticate in time')
  }, 5000)
}

function disconnectWhenInactive (ws) {
  if (ws.nostr.inactivityTimeout) return
  const then = Date.now()
  ws.nostr.inactivityTimeout = setTimeout(() => {
    if (Object.keys(ws.nostr.subscriptions).length > 0) return // will reset timeout on close
    if (ws.nostr.lastActiveAtMs > then) {
      delete ws.nostr.inactivityTimeout
      return disconnectWhenInactive(ws)
    }
    ws.close(1013, 'Casting off client due to inactivity')
  }, 1000 * 60 * 3)
}

function returnReqToPubkeyRateLimitPool (ws) {
  const { pubkey } = ws.nostr
  if (!pubkey) return // if closing connection before authentication

  openConnectionsByPubkey[pubkey]--
  if (openConnectionsByPubkey[pubkey] === 0) delete openConnectionsByPubkey[pubkey]
}

export {
  rateLimitReqByIp,
  rateLimitReqByPubkey,
  returnReqToIpRateLimitPool,
  returnReqToPubkeyRateLimitPool,
  disconnectIfNotAuthenticatedAfterSomeTime,
  disconnectWhenInactive
}
