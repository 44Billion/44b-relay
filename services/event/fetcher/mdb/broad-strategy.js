import { getEvents } from '#models/event/dao.js'

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
    const tags = Object.fromEntries(
      Object.entries(filter)
        .filter(([k, v]) => /^#[a-zA-Z]$/.test(k) && Array.isArray(v) && v.length > 0)
        .map(([k, v]) => [k.slice(1), v])
    )

    const query = {
      ...filter,
      tags
    }

    // Popularity check for broad filters
    if (filter.isBroad && process.env.IS_INTEGRATION_TEST !== 'true') {
      if (!filter.includeSpam) {
        query.popularityLevel = 6
      }
    }

    try {
      // Dao handles defaults for fields if undefined
      const { result: events, success } = await getEvents(query)

      if (success && events) {
        for (const event of events) {
          yield event
        }
      }
    } catch (err) {
      console.error('Error fetching events from MDB:', err)
      // Yield nothing on error
    }
  }
}
