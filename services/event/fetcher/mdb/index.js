import BroadStrategy from '#services/event/fetcher/mdb/broad-strategy.js'

export default class EventFetcher {
  constructor (filters) {
    Object.assign(this, { filters })
  }

  static run (filters) {
    return new this(filters).fetch()
  }

  async * fetch () {
    const { filters } = this

    for (const filter of filters) {
      if (filter.limit === 0) continue

      // if (BroadStrategy.doesWorkFor(filter)) {
      yield * BroadStrategy.run(filter)
      // }
    }
  }
}
