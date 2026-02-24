import { trackIpActivity } from '#services/event/tracker/mdb/ip-activity.js'
import { sendCount, sendClosed } from '#helpers/message.js'
import { parseSubscriptionFilters, isBroadFilter } from '#helpers/subscription.js'
import { blockHighFilterCount, applyCustomRelayRestrictionsToNostrFilter, adjustUntilFieldInFilters } from './req-handler.js'
import { isType } from '#helpers/shared.js'
import { countEvents, getEventByRef } from '#models/event/dao.js'
import { idToRef, addressToRef } from '#models/event/mapper.js'
import { eventKinds } from '#constants/event.js'

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
        ;({ isBlocked, message } = applyCustomRelayRestrictionsToNostrFilter({ ws, filter, isBroad: filter.isBroad }))
        if (isBlocked) {
          return sendClosed({ ws, subscriptionId, message })
        }
      }

      try {
        const filtersForCounting = adjustUntilFieldInFilters({ ws, filters })
        const { count, approximate, hll } = await countFilteredEvents({ ws, filters: filtersForCounting })
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
  if (Object.keys(filter).filter(key => key.startsWith('#')).length !== 1) return

  let { kinds } = filter
  if (kinds.length === 1) {
    switch (kinds[0]) {
      // { kinds: [1111], '#E': ['<rootEventId>'] }
      case eventKinds.COMMENT: {
        let mapperFn
        let rootEventIdOrAddress
        if (filter['#E']?.length === 1) {
          mapperFn = idToRef
          rootEventIdOrAddress = filter['#E'][0]
        } else if (filter['#A']?.length === 1) {
          mapperFn = addressToRef
          rootEventIdOrAddress = filter['#A'][0]
        } else return

        const { result: event } = await getEventByRef(
          mapperFn(rootEventIdOrAddress), { fields: ['commentCounter'], withMeta: true }
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
        if (filter['#e']?.length !== 1) return

        const rootEventId = filter['#e'][0]
        const { result: event } = await getEventByRef(
          idToRef(rootEventId), { fields: ['replyCounter'], withMeta: true }
        )
        return event?.meta?.replyCounter
      }
      // { kinds: [6], '#e': ['<rootEventId>'] }
      // (Generic) Repost integer counts (not counter) and quotes integer counts
      // should be summed up as one because UIs treat them as one when showing counts
      case eventKinds.REPOST: {
        if (filter['#e']?.length !== 1) return

        const rootEventId = filter['#e'][0]
        const { result: event } = await getEventByRef(
          idToRef(rootEventId), { fields: ['repostCounter'], withMeta: true }
        )
        return event?.meta?.repostCounter
      }
      // https://github.com/nostr-protocol/nips/blob/master/18.md
      // { kinds: [16], '#e': ['<rootEventId>'] }
      // { kinds: [16], '#a': ['<rootEventId>'] }
      case eventKinds.GENERIC_REPOST: {
        let mapperFn
        let rootEventIdOrAddress
        if (filter['#e']?.length === 1) {
          mapperFn = idToRef
          rootEventIdOrAddress = filter['#e'][0]
        } else if (filter['#a']?.length === 1) {
          mapperFn = addressToRef
          rootEventIdOrAddress = filter['#a'][0]
        } else return

        const { result: event } = await getEventByRef(
          mapperFn(rootEventIdOrAddress), { fields: ['repostCounter'], withMeta: true }
        )
        return event?.meta?.repostCounter
      }
    }
  } else if (kinds.length === 2) {
    kinds = kinds.toSorted((a, b) => a - b)

    // { '#q': ['<rootEventId or rootEventAddress>'], kinds: [1, 1111] }
    if (
      (kinds[0] !== eventKinds.TEXT_NOTE || kinds[1] !== eventKinds.COMMENT) ||
      filter['#q']?.length !== 1 ||
      Object.keys(filter).filter(key => key.startsWith('#')).length !== 1
    ) return

    const rootEventIdOrAddress = filter['#q'][0]
    const mapperFn = rootEventIdOrAddress.length === 64 ? idToRef : addressToRef
    const { result: event } = await getEventByRef(
      mapperFn(rootEventIdOrAddress), { fields: ['quoteCounter'], withMeta: true }
    )
    return event?.meta?.quoteCounter
  }
}

async function countFilteredEvents ({ ws, filters }) {
  let totalCount = 0
  let hll

  for (const filter of filters) {
    if (filter.limit === 0) continue

    const query = { ...filter }
    // Popularity check for broad filters
    // as seen at services/event/fetcher/mdb/broad-strategy.js
    if (filter.isBroad && process.env.IS_INTEGRATION_TEST !== 'true') {
      if (filter.isSpam) {
        query.spamOnly = true
      } else if (!filter.includeSpam) {
        query.popularityLevel = 6
      }
    }

    const { result, success } = await countEvents(query)
    if (success && result) {
      totalCount += result
    }
  }
  if (totalCount && !filters[0].includeSpam && !filters[0].isSpam) hll = await maybeGetHll(filters)

  trackIpActivity({ ip: ws.ip })
  return {
    count: totalCount,
    // `countEvents` uses mdb's estimatedTotalHits for speed
    ...(totalCount > 0 && { approximate: true }),
    ...(hll && { hll })
  }
}

export default CountHandler
