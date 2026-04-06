import { rateLimitByKey } from '#helpers/request.js'
import { isType } from '#helpers/shared.js'
import { eventKinds } from '#constants/event.js'

const LIMIT_MULTIPLIER = process.env.IS_INTEGRATION_TEST === 'true' ? 1000 : 1

export const MESSAGE_GLOBAL_REQS_PER_WINDOW = 60 * LIMIT_MULTIPLIER
export const MESSAGE_GLOBAL_WINDOW_SECONDS = 2

export const AUTH_REQS_PER_WINDOW = 60 * LIMIT_MULTIPLIER
export const AUTH_BURST_REQS_PER_WINDOW = 6 * LIMIT_MULTIPLIER

function rateLimitNostrMessageByPubkey (ws) {
  const { ip, nostr: { pubkey } } = ws
  const { isRateLimited, nextWindow } = rateLimitByKey({ key: 'message::global::' + (pubkey ?? ip), reqsPerWindow: MESSAGE_GLOBAL_REQS_PER_WINDOW, windowSeconds: MESSAGE_GLOBAL_WINDOW_SECONDS })

  return { isRateLimited, nextWindow }
}

function rateLimitNostrAuthMessageByPubkey (ws) {
  const { ip, nostr: { pubkey } } = ws
  let { isRateLimited, nextWindow } = rateLimitByKey({ key: 'message::auth::' + (pubkey ?? ip) + '::a', reqsPerWindow: AUTH_REQS_PER_WINDOW, windowMinutes: 1 })
  if (isRateLimited) return { isRateLimited, nextWindow }
  ;({ isRateLimited, nextWindow } = rateLimitByKey({ key: 'message::auth::' + (pubkey ?? ip) + '::b', reqsPerWindow: AUTH_BURST_REQS_PER_WINDOW, windowSeconds: 1 }))

  return { isRateLimited, nextWindow }
}

// considering MAX_OPEN_CONNECTIONS = 30 per ip
// if client does 1 conn per pubkey -> 30 pubkeys per ip -> 30 subs per conn/pubkey -> 900 subs total per ip
export const MAX_SUBSCRIPTIONS_PER_WS_CONNECTION = 30 * LIMIT_MULTIPLIER
function rateLimitNostrReqMessageByWsConnection (ws, subscriptionId) {
  if (!isType(subscriptionId, 'string')) return { isRateLimited: false } // it will be invalid ahead at ReqHandler
  const { subscriptions } = ws.nostr

  const isSubscriptionReplaceRequest = !!subscriptions[subscriptionId]
  if (isSubscriptionReplaceRequest) return { isRateLimited: false }

  return { isRateLimited: Object.keys(subscriptions).length >= MAX_SUBSCRIPTIONS_PER_WS_CONNECTION }
}

// considering MAX_OPEN_CONNECTIONS_PER_PUBKEY = 15 and MAX_OPEN_CONNECTIONS = 30 per ip
// per-connection limit is 30 subs, so a pubkey needs only 5 connections to reach 150 subs
// worst case per ip: 30 conns × 30 subs/conn = 900 subs, but capped at 150/pubkey
export const MAX_SUBSCRIPTIONS_PER_PUBKEY = 150 * LIMIT_MULTIPLIER
export const MAX_FILTERS_PER_PUBKEY = 150 * LIMIT_MULTIPLIER
// this may be slow because of wss.clients loop
function rateLimitNostrReqMessageByPubkey (wss, ws, subscriptionId, filters) {
  if (!isType(subscriptionId, 'string')) return { isRateLimited: false } // it will be invalid ahead at ReqHandler
  const { pubkey } = ws.nostr
  if (!pubkey) return { isRateLimited: false }

  const { subscriptions } = ws.nostr

  const isSubscriptionReplaceRequest = !!subscriptions[subscriptionId]
  if (isSubscriptionReplaceRequest) {
    let filterCount = 0
    for (const ws of wss.clients) {
      for (const [subId, v] of Object.entries(ws.nostr.subscriptions)) {
        const currentFiltersCount = subscriptionId === subId ? filters.length : v.filters.length
        if ((filterCount += currentFiltersCount) >= MAX_FILTERS_PER_PUBKEY) return { isRateLimited: true }
      }
    }

    return { isRateLimited: false }
  }

  let subCount = 0
  let filterCount = 0
  for (const ws of wss.clients) {
    for (const [, v] of Object.entries(ws.nostr.subscriptions)) {
      if (++subCount >= MAX_SUBSCRIPTIONS_PER_PUBKEY) return { isRateLimited: true }
      if ((filterCount += v.filters.length) >= MAX_FILTERS_PER_PUBKEY) return { isRateLimited: true }
    }
  }
  return { isRateLimited: false }
}

function rateLimitNostrEventMessageByPubkey (ws, event) {
  const { pubkey } = ws.nostr
  if (!pubkey || !event || !isType(event, 'object')) return { isRateLimited: false }

  let isRateLimited = false
  let nextWindow
  switch (event.kind) {
    // 7/min
    case eventKinds.METADATA:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}`, reqsPerWindow: 7 * LIMIT_MULTIPLIER, windowMinutes: 1 }))
      break
    // 10/2min, burst 1/3s
    case eventKinds.TEXT_NOTE:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}::a`, reqsPerWindow: 10 * LIMIT_MULTIPLIER, windowMinutes: 2 }))
      if (!isRateLimited) ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}::b`, reqsPerWindow: 1 * LIMIT_MULTIPLIER, windowSeconds: 3 }))
      break
    // 5/10min
    case eventKinds.RECOMMEND_RELAY:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}`, reqsPerWindow: 5 * LIMIT_MULTIPLIER, windowMinutes: 10 }))
      break
    // 25/2min
    case eventKinds.FOLLOWS:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}`, reqsPerWindow: 25 * LIMIT_MULTIPLIER, windowMinutes: 2 }))
      break
    // 20/min
    case eventKinds.DELETION:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}`, reqsPerWindow: 20 * LIMIT_MULTIPLIER, windowMinutes: 1 }))
      break
    // 10/min, burst 1/3s (shared bucket for both kinds)
    case eventKinds.REPOST:
    case eventKinds.GENERIC_REPOST:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::repost::${pubkey}::a`, reqsPerWindow: 10 * LIMIT_MULTIPLIER, windowMinutes: 1 }))
      if (!isRateLimited) ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::repost::${pubkey}::b`, reqsPerWindow: 1 * LIMIT_MULTIPLIER, windowSeconds: 3 }))
      break
    // 15/min, burst 1/2s
    case eventKinds.REACTION:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}::a`, reqsPerWindow: 15 * LIMIT_MULTIPLIER, windowMinutes: 1 }))
      if (!isRateLimited) ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}::b`, reqsPerWindow: 1 * LIMIT_MULTIPLIER, windowSeconds: 2 }))
      break
    // 10/2min, burst 1/3s
    case eventKinds.COMMENT:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}::a`, reqsPerWindow: 10 * LIMIT_MULTIPLIER, windowMinutes: 2 }))
      if (!isRateLimited) ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}::b`, reqsPerWindow: 1 * LIMIT_MULTIPLIER, windowSeconds: 3 }))
      break
    // 5/10min
    case eventKinds.LONG_FORM_CONTENT:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}`, reqsPerWindow: 5 * LIMIT_MULTIPLIER, windowMinutes: 10 }))
      break
    // 30/min, burst 2/s
    case eventKinds.ENCRYPTED_DIRECT_MESSAGE:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}::a`, reqsPerWindow: 30 * LIMIT_MULTIPLIER, windowMinutes: 1 }))
      if (!isRateLimited) ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}::b`, reqsPerWindow: 2 * LIMIT_MULTIPLIER, windowSeconds: 1 }))
      break
    // 15/min, burst 2/s
    default:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::default::${pubkey}::a`, reqsPerWindow: 15 * LIMIT_MULTIPLIER, windowMinutes: 1 }))
      if (!isRateLimited) ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::default::${pubkey}::b`, reqsPerWindow: 2 * LIMIT_MULTIPLIER, windowSeconds: 1 }))
      break
  }

  return { isRateLimited, nextWindow }
}

export {
  rateLimitNostrMessageByPubkey,
  rateLimitNostrAuthMessageByPubkey,
  rateLimitNostrReqMessageByWsConnection,
  rateLimitNostrReqMessageByPubkey,
  rateLimitNostrEventMessageByPubkey
}
