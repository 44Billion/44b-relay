import { getFilterInterests, uninterestedIn, trackRequestedPubkeys } from '#services/event/tracker/mdb/requested-pubkeys.js'
import { trackIpActivity } from '#services/event/tracker/mdb/ip-activity.js'
import { sendEvent, sendEose, sendClosed } from '#helpers/message.js'
// import { isAuthenticated, requestAuthentication } from '#services/relay/authenticator.js'
import { parseSubscriptionFilters, isBroadFilter, isAllowedEvenIfBroadFilter } from '#helpers/subscription.js'
// import { eventKinds } from '#constants/event.js'
import { webSocketReadyState } from '#constants/web-socket.js'
import { isType } from '#helpers/shared.js'
import { disconnectWhenInactive } from '#services/rate-limiting/web-socket-request-limiter.js'
import EventFetcher from '#services/event/fetcher/mdb/index.js'
// import { keepTrackOfPubkey } from '#models/event.js'
import { maybeUnref } from '#helpers/timer.js'

class ReqHandler {
  static run ({ wss, ws, nostrMessage }) {
    return new this({ wss, ws, nostrMessage }).run()
  }

  constructor ({ wss, ws, nostrMessage }) {
    Object.assign(this, { wss, ws, nostrMessage })
  }

  async run () {
    const { ws, nostrMessage } = this
    let [, subscriptionId, ...filters] = nostrMessage
    if (!isType(subscriptionId, 'string')) {
      deleteSubscription({ ws, subscriptionId })
      return sendClosed({ ws, subscriptionId, message: 'invalid: wrong subscription id type' })
    }

    filters = parseSubscriptionFilters({ filters })
    const { isBlocked } = blockHighFilterCount({ ws, subscriptionId, filters })
    if (isBlocked) return deleteSubscription({ ws, subscriptionId })
    // Don't, as different napps using same connection may use same filters again
    // const { isIgnored } = ignoreDuplicateFilters({ ws, filters, subscriptionId })
    // if (isIgnored) return

    if (filters.length > 0) {
      const subscriptionReplaceRequestMoment = Date.now()
      ws.nostr.subscriptions[subscriptionId] ??= {}
      ws.nostr.subscriptions[subscriptionId].replaceAtMs = subscriptionReplaceRequestMoment
      ws.nostr.subscriptions[subscriptionId].filters = filters

      let isBlocked, message
      for (const filter of filters) {
        filter.isBroad = isBroadFilter(filter)
        ;({ isBlocked, message } = applyCustomRelayRestrictionsToNostrFilter({ ws, filter, isBroad: filter.isBroad }))
        if (isBlocked) {
          // hasn't awaited anything (not async), so won't check replaceAtMs (hasNoFutureSubscriptionReplaceRequest)
          deleteSubscription({ ws, subscriptionId })
          return sendClosed({ ws, subscriptionId, message })
        }
      }
      let sentEventCount = 0
      try {
        const filtersForFetching = adjustUntilFieldInFilters({ ws, filters })
        ;({ sentEventCount = 0 } = await sendFilteredEvents({ ws, subscriptionId, filters: filtersForFetching }))
      } catch (err) {
        console.log(err.stack)
      } finally {
        await sendEose({ ws, subscriptionId })
        // await keepTrackOfPubkey({ ws, action: 'subscribe' })
      }
      const hasNoFutureSubscriptionReplaceRequest = ws.nostr.subscriptions[subscriptionId] && ws.nostr.subscriptions[subscriptionId].replaceAtMs === subscriptionReplaceRequestMoment
      if (hasNoFutureSubscriptionReplaceRequest) {
        const nowSecs = Date.now() / 1000
        const liveFilters = filters.filter(v => v.until === undefined || v.until > nowSecs)
        const allRequestedEventsWereFound =
          sentEventCount > 0 &&
          // no prefix id
          filters.every(filter => !filter.ids?.length || filter.ids.every(v => /^[0-9a-f]{64}$/.test(v))) &&
          filters.map(v => v.ids || []).flat().length === sentEventCount

        if (liveFilters.length === 0 || allRequestedEventsWereFound) {
          deleteSubscription({ ws, subscriptionId })
          sendClosed({ ws, subscriptionId, message: 'completed: subscription ended' })
        } else {
          ws.nostr.subscriptions[subscriptionId].filters = liveFilters
          scheduleSubscriptionCleanup({ ws, subscriptionId })
        }
      }
    } else {
      // hasn't awaited anything (not async), so won't check replaceAtMs (hasNoFutureSubscriptionReplaceRequest)
      deleteSubscription({ ws, subscriptionId })
      sendClosed({ ws, subscriptionId, message: 'invalid: no valid filters' })
    }
  }
}

function deleteSubscription ({ ws, subscriptionId }) {
  const subscription = ws.nostr.subscriptions[subscriptionId]
  if (subscription?.cleanupTimeout) clearTimeout(subscription.cleanupTimeout)
  delete ws.nostr.subscriptions[subscriptionId]
  if (Object.keys(ws.nostr.subscriptions).length === 0) disconnectWhenInactive(ws)
}

async function sendFilteredEvents ({ ws, subscriptionId, filters }) {
  const generator = EventFetcher.run(filters)
  let sentEventCount = 0
  const interestedIn = getFilterInterests({ filters })
  // tb olhe os comments do fetcher e no saver (do deta) como apagar eventos desnecessarios?
  // acho que kda 24 de distancia, soma 1 dia. se tiver 3 dias, ok, senao, nops
  for await (const event of generator) {
    if (
      !uninterestedIn.kinds[event.kind] &&
      interestedIn.ids[event.id]
    ) interestedIn.pubkeys.add(event.pubkey)

    await sendEvent({ ws, subscriptionId, event })
    sentEventCount++
  }
  trackRequestedPubkeys({ pubkeys: [...interestedIn.pubkeys], ip: ws.ip })
  trackIpActivity({ ip: ws.ip })
  return { sentEventCount }
}

const MAX_FILTERS_PER_SUBSCRIPTION = 5
export function blockHighFilterCount ({ ws, subscriptionId, filters }) {
  const isBlocked = filters.length > MAX_FILTERS_PER_SUBSCRIPTION
  if (isBlocked) sendClosed({ ws, subscriptionId, message: 'error: too many filters' })

  return { isBlocked }
}

// Commented out because same connection may be shared by different napps
// thus same filters may be used again legitimately
// const filtersDiffer = (() => {
//   function arrayToObject (array) { return array.reduce((memo, item, i) => ({ ...memo, [i]: item }), {}) }
//   function filterDiffer (a, b) {
//     let i
//     for (i in a) if (!(i in b)) return true
//     for (i in b) {
//       if (Array.isArray(a[i])) {
//         if (filterDiffer(arrayToObject(a[i]), arrayToObject(b[i]))) return true
//       } else if (a[i] !== b[i]) return true
//     }
//     return false
//   }
//   return (filtersA, filtersB) => filtersA.some((v, i) => filterDiffer(v, filtersB[i]))
// })()
// function ignoreDuplicateFilters ({ ws, filters, subscriptionId }) {
//   const oldFilters = ws.nostr.subscriptions[subscriptionId].filters
//   const isIgnored = !!oldFilters && !filtersDiffer(oldFilters, filters)
//   if (isIgnored) sendClosed({ ws, subscriptionId, message: `duplicate: duplicate subscription ${subscriptionId}` })

//   return { isIgnored }
// }

export function applyCustomRelayRestrictionsToNostrFilter ({ /* ws, */ filter, isBroad = isBroadFilter(filter) }) {
  if (isBroad && !isAllowedEvenIfBroadFilter(filter)) return { isBlocked: true, message: 'error: overly broad filters are not allowed.' }

  // For now, Ignore Harvest Now, Decrypt Later (HNDL) attacks
  // (storing encrypted DMs for later decryption when having the key)
  // because quantum computers won't happen soon enough or ever
  // - Post-quantum cryptography reduces funding for cryptographically relevant quantum computers
  // (If the world successfully migrates to PQC before such a computer exists, the "bounty" for building it vanishes)
  // - Money has already moved elsewhere (LLM)
  // - https://eprint.iacr.org/2025/1237.pdf - "Replication of Quantum Factorisation Records with an 8-bit Home Computer, an Abacus, and a Dog"
  //
  // const kinds = (filter.kinds ?? []).reduce((memo, item) => { memo[item] = true; return memo })
  // const authors = filter.authors ?? []
  // const tags = {
  //   p: filter['#p'] ?? []
  // }
  // if (
  //   // TODO: A broad filter may include encrypted DMs thus should be blocked for unauthenticated users
  //   kinds[eventKinds.ENCRYPTED_DIRECT_MESSAGE]
  // ) {
  //   if (!isAuthenticated({ ws })) {
  //     requestAuthentication({ ws })
  //     return { isBlocked: true, message: 'auth-required: unauthenticated users can\'t subscribe to encrypted direct messages.' }
  //   }
  //   if (
  //     (authors.length !== 1 && tags.p.length !== 1) || // must be sender or receiver
  //     (authors.length === 1 && authors[0] !== ws.nostr.pubkey) ||
  //     (tags.p.length === 1 && tags.p[0] !== ws.nostr.pubkey)
  //   ) return { isBlocked: true, message: 'restricted: authenticated user does not have authorization for requested filters.' }
  // }

  return { isBlocked: false, message: '' }
}

export function adjustUntilFieldInFilters ({ ws, filters }) {
  const maxUntil = Math.floor(Date.now() / 1000) + 10 * 60 // 10 min buffer
  return filters.map(filter => {
    if (
      filter.authors?.length === 1 &&
      ws.nostr.pubkey &&
      filter.authors[0] === ws.nostr.pubkey
    ) return filter

    if (filter.until === undefined || filter.until > maxUntil) {
      return { ...filter, until: maxUntil }
    }
    return filter
  })
}

function scheduleSubscriptionCleanup ({ ws, subscriptionId }) {
  const subscription = ws.nostr.subscriptions[subscriptionId]
  if (!subscription) return

  if (subscription.cleanupTimeout) clearTimeout(subscription.cleanupTimeout)

  const nowSecs = Date.now() / 1000
  // Find the earliest until that is in the future
  const futureUntils = subscription.filters
    .map(f => f.until)
    .filter(u => u !== undefined && u > nowSecs)

  if (futureUntils.length === 0) return // No future expiration to wait for

  const nextExpiration = Math.min(...futureUntils)
  const delayMs = (nextExpiration - nowSecs) * 1000 + 100 // +100ms buffer

  if (delayMs > 2147483647) return

  subscription.cleanupTimeout = maybeUnref(setTimeout(() => {
    cleanupSubscription({ ws, subscriptionId })
  }, delayMs))
}

function cleanupSubscription ({ ws, subscriptionId }) {
  const subscription = ws.nostr.subscriptions[subscriptionId]
  if (!subscription) return
  if (ws.readyState !== webSocketReadyState.OPEN) return

  const nowSecs = Date.now() / 1000
  const liveFilters = subscription.filters.filter(v => v.until === undefined || v.until > nowSecs)

  if (liveFilters.length === 0) {
    deleteSubscription({ ws, subscriptionId })
    sendClosed({ ws, subscriptionId, message: 'completed: subscription ended' })
  } else {
    subscription.filters = liveFilters
    scheduleSubscriptionCleanup({ ws, subscriptionId })
  }
}

export default ReqHandler
