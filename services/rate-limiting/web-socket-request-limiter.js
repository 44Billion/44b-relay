import { rateLimitByKey, getIp } from '#helpers/request.js'
import { isAuthenticated } from '#services/relay/authenticator.js'
import { maybeUnref } from '#helpers/timer.js'

// 1. 30 open reqs per ip - considering many users with same ip
// 2. 10 new reqs per 5 seconds - considering users opening new tabs
// 2. 3 new reqs per second - considering 3 users at same second
const MAX_OPEN_CONNECTIONS = process.env.IS_INTEGRATION_TEST === 'true' ? 1000 : 30
const openConnectionsByIp = {}
const reqsPerWindowA = process.env.IS_INTEGRATION_TEST === 'true' ? 1000 : 10
const reqsPerWindowB = process.env.IS_INTEGRATION_TEST === 'true' ? 1000 : 3

function rateLimitReqByIp (req) {
  const ip = getIp(req)
  openConnectionsByIp[ip] ??= 0
  let isRateLimited = openConnectionsByIp[ip] === MAX_OPEN_CONNECTIONS
  if (isRateLimited) return { isRateLimited }

  openConnectionsByIp[ip]++
  ;({ isRateLimited } = rateLimitByKey({ key: 'webSocket::' + ip + '::a', reqsPerWindow: reqsPerWindowA, windowSeconds: 5 }))
  if (isRateLimited) return { isRateLimited }

  ;({ isRateLimited } = rateLimitByKey({ key: 'webSocket::' + ip + '::b', reqsPerWindow: reqsPerWindowB, windowSeconds: 1 }))
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
  maybeUnref(setTimeout(() => {
    if (isAuthenticated({ ws })) return
    ws.close(1000, 'Didn\'t authenticate in time')
  }, 5000))
}

function disconnectWhenInactive (ws) {
  if (ws.nostr.inactivityTimeout) return
  const then = Date.now()
  ws.nostr.inactivityTimeout = maybeUnref(setTimeout(() => {
    if (Object.keys(ws.nostr.subscriptions).length > 0) {
      delete ws.nostr.inactivityTimeout
      return // will reset timeout on close: services/relay/nostr-message-handler/close-handler.js#L16
    }
    if (ws.nostr.lastActiveAtMs > then) {
      delete ws.nostr.inactivityTimeout
      return disconnectWhenInactive(ws)
    }
    ws.close(1013, 'Casting off client due to inactivity')
  }, 1000 * 60 * 3))
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
