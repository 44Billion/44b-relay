import { trackIpActivity } from '#services/event/tracker/mdb/ip-activity.js'
import { sendCount, sendClosed } from '#helpers/message.js'
import { parseSubscriptionFilters, isBroadFilter } from '#helpers/subscription.js'
import { blockHighFilterCount, applyCustomRelayRestrictionsToNostrFilter, adjustUntilFieldInFilters } from './req-handler.js'
import { isType } from '#helpers/shared.js'
import { countEvents } from '#models/event/dao.js'

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
        const { count } = await countFilteredEvents({ ws, filters: filtersForCounting })
        sendCount({ ws, subscriptionId, count })
      } catch (err) {
        console.log(err.stack)
        sendClosed({ ws, subscriptionId, message: 'error: failed to count events' })
      }
    } else {
      sendClosed({ ws, subscriptionId, message: 'invalid: no valid filters' })
    }
  }
}

async function countFilteredEvents ({ ws, filters }) {
  let totalCount = 0
  for (const filter of filters) {
    if (filter.limit === 0) continue

    const query = { ...filter }
    // Popularity check for broad filters
    // as seen at services/event/fetcher/mdb/broad-strategy.js
    if (filter.isBroad && process.env.IS_INTEGRATION_TEST !== 'true') {
      if (!filter.includeSpam) {
        query.popularityLevel = 6
      }
    }

    const { result, success } = await countEvents(query)
    if (success && result) {
      totalCount += result
    }
  }

  trackIpActivity({ ip: ws.ip })
  return {
    count: totalCount,
    // `countEvents` uses mdb's estimatedTotalHits for speed
    approximate: totalCount > 0
  }
}

export default CountHandler
