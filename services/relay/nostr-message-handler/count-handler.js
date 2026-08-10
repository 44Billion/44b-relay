import { trackIpActivity } from '#services/event/tracker/mdb/ip-activity.js'
import { sendCount, sendClosed } from '#helpers/message.js'
import { parseSubscriptionFilters, isBroadFilter, buildPopularityFilter, buildTagQuery, applyPathExtensionsToFilter } from '#helpers/subscription.js'
import { blockHighFilterCount, applyCustomRelayRestrictionsToNostrFilter, adjustUntilFieldInFilters } from './req-handler.js'
import { isType } from '#helpers/shared.js'
import { countEvents, getEventByRef } from '#models/event/dao.js'
import { idToRef, addressToRef } from '#models/event/mapper.js'
import { eventKinds } from '#constants/event.js'

const HEX_EVENT_ID = /^[0-9a-f]{64}$/i

class CountHandler {
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
      return sendClosed({ ws, subscriptionId, message: 'invalid: wrong subscription id type' })
    }

    filters = parseSubscriptionFilters({ filters })
    const { isBlocked } = blockHighFilterCount({ ws, subscriptionId, filters })
    if (isBlocked) return

    if (filters.length > 0) {
      let isBlocked, message
      for (const filter of filters) {
        filter.isBroad = isBroadFilter(filter)
        applyPathExtensionsToFilter(filter, ws.nostr.pathExtensions)
        ;({ isBlocked, message } = applyCustomRelayRestrictionsToNostrFilter({ ws, filter, isBroad: filter.isBroad }))
        if (isBlocked) {
          return sendClosed({ ws, subscriptionId, message })
        }
      }

      try {
        const filtersForCounting = adjustUntilFieldInFilters({ ws, filters })
        const { count, approximate, hll } = await countFilteredEvents({
          ws,
          filters: filtersForCounting,
          hllFilters: filters
        })
        sendCount({ ws, subscriptionId, count, approximate, hll })
      } catch (err) {
        console.log(err.stack)
        sendClosed({ ws, subscriptionId, message: 'error: failed to count events' })
      }
    } else {
      sendClosed({ ws, subscriptionId, message: 'invalid: no valid filters' })
    }
  }
}

async function maybeGetHll (filters) {
  if (filters.length !== 1) return

  const filter = filters[0]
  if (!Array.isArray(filter.kinds)) return

  const tagKeys = Object.keys(filter).filter(key => key.startsWith('#'))
  if (tagKeys.length !== 1) return

  const tagKey = tagKeys[0]
  const tagValues = filter[tagKey]
  if (!Array.isArray(tagValues) || tagValues.length !== 1) return

  // Cached HLL counters only describe the canonical kinds + target-tag query.
  // Internal broadness metadata does not change the matching event set.
  const allowedKeys = new Set(['kinds', 'isBroad', tagKey])
  if (Object.keys(filter).some(key => !allowedKeys.has(key))) return

  const target = tagValues[0]
  const idRef = () => HEX_EVENT_ID.test(target) ? idToRef(target) : undefined
  const addressRef = () => isValidAddress(target) ? addressToRef({ address: target }) : undefined

  let { kinds } = filter
  if (kinds.length === 1) {
    switch (kinds[0]) {
      // { kinds: [1111], '#E': ['<rootEventId>'] }
      // { kinds: [1111], '#A': ['<rootEventAddress>'] }
      // { kinds: [1111], '#e': ['<parentCommentEventId>'] }
      case eventKinds.COMMENT: {
        let ref
        if (tagKey === '#E' || tagKey === '#e') ref = idRef()
        else if (tagKey === '#A') ref = addressRef()
        if (!ref) return

        const { result: event } = await getEventByRef(
          ref, { fields: ['commentCounter'], withMeta: true }
        )
        return event?.meta?.commentCounter
      }
      // { kinds: [1], '#e': ['<rootEventId>'] }
      // This hll counter (replyCounter) can't be stored w/ commentCounter as one
      // because they are requested separately,
      // though their integer counts may be summed up as one
      // because a root kind:1 event, although off-spec,
      // may have kind:1111 replies, not just kind:1 ones
      // as both replies and comments are the same thing in practice,
      // just different kinds for technical reasons
      case eventKinds.TEXT_NOTE: {
        if (tagKey !== '#e') return

        const ref = idRef()
        if (!ref) return
        const { result: event } = await getEventByRef(
          ref, { fields: ['replyCounter'], withMeta: true }
        )
        return event?.meta?.replyCounter
      }
      // { kinds: [6], '#e': ['<rootEventId>'] }
      // (Generic) Repost integer counts (not counter) and quotes integer counts
      // should be summed up as one because UIs treat them as one when showing counts
      case eventKinds.REPOST: {
        if (tagKey !== '#e') return

        const ref = idRef()
        if (!ref) return
        const { result: event } = await getEventByRef(
          ref, { fields: ['repostCounter'], withMeta: true }
        )
        return event?.meta?.repostCounter
      }
      // https://github.com/nostr-protocol/nips/blob/master/18.md
      // { kinds: [16], '#e': ['<rootEventId>'] }
      // { kinds: [16], '#a': ['<rootEventId>'] }
      case eventKinds.GENERIC_REPOST: {
        let ref
        if (tagKey === '#e') ref = idRef()
        else if (tagKey === '#a') ref = addressRef()
        if (!ref) return

        const { result: event } = await getEventByRef(
          ref, { fields: ['repostCounter'], withMeta: true }
        )
        return event?.meta?.repostCounter
      }
    }
  } else if (kinds.length === 2) {
    kinds = kinds.toSorted((a, b) => a - b)

    // { '#q': ['<rootEventId>'], kinds: [1, 1111] }
    if (
      (kinds[0] !== eventKinds.TEXT_NOTE || kinds[1] !== eventKinds.COMMENT) ||
      tagKey !== '#q'
    ) return

    // Quotes are counted only for event-id targets; address targets are not
    // maintained by the saver.
    const ref = idRef()
    if (!ref) return
    const { result: event } = await getEventByRef(
      ref, { fields: ['quoteCounter'], withMeta: true }
    )
    return event?.meta?.quoteCounter
  }
}

function isValidAddress (address) {
  if (typeof address !== 'string') return false
  const firstSeparator = address.indexOf(':')
  const secondSeparator = address.indexOf(':', firstSeparator + 1)
  if (firstSeparator <= 0 || secondSeparator < 0) return false

  const kind = address.slice(0, firstSeparator)
  const pubkey = address.slice(firstSeparator + 1, secondSeparator)
  const numericKind = Number(kind)
  return /^(0|[1-9][0-9]*)$/.test(kind) &&
    Number.isSafeInteger(numericKind) &&
    HEX_EVENT_ID.test(pubkey)
}

async function countFilteredEvents ({ ws, filters, hllFilters = filters }) {
  let totalCount = 0
  let hll

  for (const filter of filters) {
    if (filter.limit === 0) continue

    const query = {
      ...filter,
      tags: buildTagQuery(filter)
    }
    // Popularity check for broad filters
    // as seen at services/event/fetcher/mdb/broad-strategy.js
    if (filter.isBroad && process.env.IS_INTEGRATION_TEST !== 'true') {
      const popularityFilter = buildPopularityFilter(filter)
      if (popularityFilter) query.popularityFilter = popularityFilter
    }

    const { result, success } = await countEvents(query)
    if (success && result) {
      totalCount += result
    }
  }
  if (totalCount) hll = await maybeGetHll(hllFilters)

  trackIpActivity({ ip: ws.ip })
  return {
    count: totalCount,
    // `countEvents` uses mdb's estimatedTotalHits for speed
    ...(totalCount > 0 && { approximate: true }),
    ...(hll && { hll })
  }
}

export default CountHandler
