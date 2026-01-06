import IdStrategy from '#services/event/fetcher/deta/id-strategy.js'
import ReplaceableStrategy from '#services/event/fetcher/deta/replaceable-strategy.js'
import AuthorStrategy from '#services/event/fetcher/deta/author-strategy.js'
import BroadStrategy from '#services/event/fetcher/deta/broad-strategy.js'

// TODO: add extra __expires to events with directly requested ids on 'events' table
// TODO: update 'activePubkeys' metadata_requested_at and __expires from directly requested pubkey METADATA
export default class EventFetcher {
  constructor (filters) {
    Object.assign(this, { filters, yieldCount: 0 })
  }

  static run (filters) {
    return new this(filters).fetch()
  }

  async * fetch () {
    const { filters } = this

    // each filter has its own limit, so separate queries
    for (const filter of filters) {
      if (filter.limit === 0) continue

      let generator
      if (IdStrategy.doesWorkFor(filter)) generator = IdStrategy.run(filter)
      else if (ReplaceableStrategy.doesWorkFor(filter)) generator = ReplaceableStrategy.run(filter)
      else if (AuthorStrategy.doesWorkFor(filter)) generator = AuthorStrategy.run(filter)
      else if (BroadStrategy.doesWorkFor(filter)) generator = BroadStrategy.run(filter)

      yield * generator // async
    }
  }
}
