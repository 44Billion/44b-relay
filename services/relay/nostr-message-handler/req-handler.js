import { sendCommandResult, sendEvent, sendEose } from '#helpers/message.js'
import { isAuthenticated, requestAuthentication } from '#services/relay/authenticator.js'
import { parseSubscriptionFilters } from '#helpers/subscription.js'
import { eventKinds } from '#constants/event.js'
import { isType } from '#helpers/shared.js'
import { disconnectWhenInactive } from '#services/rate-limiting/web-socket-request-limiter.js'
import EventFetcher from '#services/event/fetcher/index.js'
import { keepTrackOfPubkey } from '#models/event.js'

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
      return sendCommandResult({ ws, event: {}, isSuccess: false, message: 'invalid: wrong subscription id type' })
    }

    filters = parseSubscriptionFilters({ filters })
    const { isBlocked } = blockHighFilterCount({ ws, subscriptionId, filters })
    if (isBlocked) return deleteSubscription({ ws, subscriptionId })
    const { isIgnored } = ignoreDuplicateFilters({ ws, filters, subscriptionId })
    if (isIgnored) return

    if (filters.length > 0) {
      const subscriptionReplaceRequestMoment = Date.now()
      ws.nostr.subscriptions[subscriptionId] ??= {}
      ws.nostr.subscriptions[subscriptionId].replaceAtMs = subscriptionReplaceRequestMoment

      let isBlocked, message
      for (const filter of filters) {
        ({ isBlocked, message } = applyCustomRelayRestrictionsToNostrFilter({ ws, filter }))
        if (isBlocked) {
          // hasn't awaited anything (not async), so won't check replaceAtMs (hasNoFutureSubscriptionReplaceRequest)
          deleteSubscription({ ws, subscriptionId })
          return sendCommandResult({ ws, event: {}, isSuccess: false, message })
        }
      }
      let sentEventCount = 0
      try {
        ;({ sentEventCount = 0 } = await sendFilteredEvents({ ws, filters }))
      } catch (err) {
        console.log(err.stack)
      } finally {
        await sendEose({ ws, subscriptionId })
        await keepTrackOfPubkey({ ws, action: 'subscribe' })
      }
      const hasNoFutureSubscriptionReplaceRequest = ws.nostr.subscriptions[subscriptionId].replaceAtMs === subscriptionReplaceRequestMoment
      if (hasNoFutureSubscriptionReplaceRequest) {
        const nowSecs = Date.now() / 1000
        const wontHaveRealtimeEvents =
          filters.every(v => v.until !== undefined && v.until <= nowSecs) ||
          (
            sentEventCount > 0 &&
            // no prefix id
            filters.every(filter => !filter.ids?.length || filter.ids.every(v => /^[0-9a-f]{64}$/.test(v))) &&
            filters.map(v => v.ids || []).flat().length === sentEventCount
          )
        if (wontHaveRealtimeEvents) deleteSubscription({ ws, subscriptionId })
        else ws.nostr.subscriptions[subscriptionId].filters = filters
      }
    } else {
      // hasn't awaited anything (not async), so won't check replaceAtMs (hasNoFutureSubscriptionReplaceRequest)
      deleteSubscription({ ws, subscriptionId })
    }
  }
}

function deleteSubscription ({ ws, subscriptionId }) {
  delete ws.nostr.subscriptions[subscriptionId]
  if (Object.keys(ws.nostr.subscriptions).length === 0) disconnectWhenInactive(ws)
}

async function sendFilteredEvents ({ ws, subscriptionId, filters }) {
  const generator = EventFetcher.run(filters)
  let sentEventCount = 0
  // tb olhe os comments do fetcher e no saver como apagar eventos desnecessarios?
  // acho que kda 24 de distancia, soma 1 dia. se tiver 3 dias, ok, senao, nops
  // e tb criar fast auth como deveria ter sido no query param nipxx=encodeURIComponent(JSON.stringify(event))
  for await (const event of generator) {
    await sendEvent({ ws, subscriptionId, event })
    sentEventCount++
  }
  return { sentEventCount }
}

const MAX_FILTERS_PER_SUBSCRIPTION = 5
function blockHighFilterCount ({ ws, filters }) {
  const isBlocked = filters.length > MAX_FILTERS_PER_SUBSCRIPTION
  if (isBlocked) sendCommandResult({ ws, event: {}, isSuccess: false, message: 'error: too many filters' })

  return { isBlocked }
}

const filtersDiffer = (() => {
  function arrayToObject (array) { return array.reduce((memo, item, i) => ({ ...memo, [i]: item }), {}) }
  function filterDiffer (a, b) {
    let i
    for (i in a) if (!(i in b)) return true
    for (i in b) {
      if (Array.isArray(a[i])) {
        if (filterDiffer(arrayToObject(a[i]), arrayToObject(b[i]))) return true
      } else if (a[i] !== b[i]) return true
    }
    return false
  }
  return (filtersA, filtersB) => filtersA.some((v, i) => filterDiffer(v, filtersB[i]))
})()
function ignoreDuplicateFilters ({ ws, filters, subscriptionId }) {
  const oldFilters = ws.nostr.subscriptions[subscriptionId].filters
  const isIgnored = !!oldFilters && !filtersDiffer(oldFilters, filters)
  if (isIgnored) sendCommandResult({ ws, event: {}, isSuccess: true, message: `duplicate: duplicate subscription ${subscriptionId}` })

  return { isIgnored }
}

function applyCustomRelayRestrictionsToNostrFilter ({ ws, filter }) {
  const kinds = (filter.kinds ?? []).reduce((memo, item) => { memo[item] = true; return memo })
  const authors = filter.authors ?? []
  const tags = {
    p: filter['#p'] ?? []
  }
  if (kinds[eventKinds.ENCRYPTED_DIRECT_MESSAGE]) {
    if (!isAuthenticated({ ws })) {
      requestAuthentication({ ws })
      return { isBlocked: true, message: 'restricted: unauthenticated users can\'t subscribe to encrypted direct messages.' }
    }
    if (
      (authors.length !== 1 && tags.p.length !== 1) || // must be sender or receiver
      (authors.length === 1 && authors[0] !== ws.nostr.pubkey) ||
      (tags.p.length === 1 && tags.p[0] !== ws.nostr.pubkey)
    ) return { isBlocked: true, message: 'error: authenticated user does not have authorization for requested filters.' }
  }

  return { isBlocked: false, message: '' }
}

// TODO: handle with a CLOSED msg filter that is so broad that we may later
// discover there are DMs in it after querying the database

export default ReqHandler
