import { rateLimitByKey } from '#helpers/request.js'
import { isType } from '#helpers/shared.js'
import { eventKinds } from '#constants/event.js'

const LIMIT_MULTIPLIER = process.env.IS_INTEGRATION_TEST === 'true' ? 1000 : 1

function rateLimitNostrMessageByPubkey (ws) {
  const { ip, nostr: { pubkey } } = ws
  const { isRateLimited, nextWindow } = rateLimitByKey({ key: 'message::global::' + (pubkey ?? ip), reqsPerWindow: 12 * LIMIT_MULTIPLIER, windowSeconds: 2 })

  return { isRateLimited, nextWindow }
}

function rateLimitNostrAuthMessageByPubkey (ws) {
  const { ip, nostr: { pubkey } } = ws
  let { isRateLimited, nextWindow } = rateLimitByKey({ key: 'message::auth::' + (pubkey ?? ip) + '::a', reqsPerWindow: 20 * LIMIT_MULTIPLIER, windowMinutes: 1 })
  if (isRateLimited) return { isRateLimited, nextWindow }
  ;({ isRateLimited, nextWindow } = rateLimitByKey({ key: 'message::auth::' + (pubkey ?? ip) + '::b', reqsPerWindow: 2 * LIMIT_MULTIPLIER, windowSeconds: 1 }))

  return { isRateLimited, nextWindow }
}

// considering MAX_OPEN_CONNECTIONS = 30 per ip
// if client does 1 conn per pubkey -> 30 pubkeys per ip -> 10 subs per conn/pubkey -> 300 subs total per ip
const MAX_SUBSCRIPTIONS_PER_WS_CONNECTION = 10 * LIMIT_MULTIPLIER
function rateLimitNostrReqMessageByWsConnection (ws, subscriptionId) {
  if (!isType(subscriptionId, 'string')) return { isRateLimited: false } // it will be invalid ahead at ReqHandler
  const { subscriptions } = ws.nostr

  const isSubscriptionReplaceRequest = !!subscriptions[subscriptionId]
  if (isSubscriptionReplaceRequest) return { isRateLimited: false }

  return { isRateLimited: Object.keys(subscriptions).length >= MAX_SUBSCRIPTIONS_PER_WS_CONNECTION }
}

// considering MAX_OPEN_CONNECTIONS_PER_PUBKEY = 15 and MAX_OPEN_CONNECTIONS = 30 per ip
// if client does 15 conn per pubkey (spam) -> 2 pubkeys per ip -> 10 subs per pubkey -> 20 subs total per ip
// (above 10 per conn would be 150 per pubkey so 300 total)
const MAX_SUBSCRIPTIONS_PER_PUBKEY = MAX_SUBSCRIPTIONS_PER_WS_CONNECTION
const MAX_FILTERS_PER_PUBKEY = MAX_SUBSCRIPTIONS_PER_WS_CONNECTION
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
    case eventKinds.METADATA:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}`, reqsPerWindow: 7 * LIMIT_MULTIPLIER, windowMinutes: 1 }))
      break
    case eventKinds.TEXT_NOTE:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}::a`, reqsPerWindow: 7 * LIMIT_MULTIPLIER, windowMinutes: 2 }))
      if (!isRateLimited) ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}::b`, reqsPerWindow: 1 * LIMIT_MULTIPLIER, windowSeconds: 5 }))
      break
    case eventKinds.RECOMMEND_RELAY:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}`, reqsPerWindow: 5 * LIMIT_MULTIPLIER, windowMinutes: 10 }))
      break
    case eventKinds.FOLLOWS:
      ({ isRateLimited, nextWindow } = rateLimitByKey({ key: `event::${event.kind}::${pubkey}`, reqsPerWindow: 25 * LIMIT_MULTIPLIER, windowMinutes: 2 }))
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
