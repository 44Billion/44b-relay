import { getEvents } from '#models/event/dao.js'
import { buildPopularityFilter, buildTagQuery } from '#helpers/subscription.js'

export default class BroadStrategy {
  static doesWorkFor () { return true }

  static run (filter) {
    return new this(filter).run()
  }

  constructor (filter) {
    Object.assign(this, { filter })
  }

  async * run () {
    const { filter } = this

    const query = {
      ...filter,
      tags: buildTagQuery(filter)
    }

    // Popularity check for broad filters
    if (filter.isBroad && process.env.IS_INTEGRATION_TEST !== 'true') {
      const popularityFilter = buildPopularityFilter(filter)
      if (popularityFilter) query.popularityFilter = popularityFilter
    }

    if (filter.sortTop) {
      query.sortTop = true
    }

    // Never turn a failed read into an empty successful snapshot.
    const { result: events, success, error } = await getEvents(query)
    if (!success || !Array.isArray(events)) {
      throw new Error('Failed to read stored events', { cause: error })
    }
    yield * events
  }
}
