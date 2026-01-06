import deta from '#services/db/deta.js'
import { doesMatchASubscriptionFilter } from '#helpers/subscription.js'
import { dbEventToEvent } from '#helpers/event.js'

const MAX_LIMIT = 200
class IdStrategy {
  static doesWorkFor (filter) {
    const regex = /^[0-9a-f]{64}$/
    return !!filter.ids?.length &&
      filter.ids.every(v => regex.test(v)) // not prefix
  }

  static run (filter) {
    new this(filter).run()
  }

  constructor (filter) {
    Object.assign(this, { filter })
  }

  async * run () {
    const filter = this
    const limit = Math.min(MAX_LIMIT, filter.limit ?? Number.MAX_SAFE_INTEGER, filter.ids.length)
    const { ids, ...filterWithoutIds } = filter
    const filters = [filterWithoutIds]
    let i

    for (i = 0; i < limit; i++) {
      const key = filter.ids[i]
      const eventMeta = await deta.Base('eventMeta').get(key)
      if (!eventMeta) continue

      const { replaceable_event_key, author, event_key } = eventMeta

      let event
      if (replaceable_event_key && author) event = await deta.Base(`replaceableEvents${author}`).get(replaceable_event_key)
      if (!event && author) event = await deta.Base(`events${author}`).delete(event_key)
      if (!event) event = await deta.Base('events').get(event_key)
      if (!event || !doesMatchASubscriptionFilter({ filters, event })) continue

      yield dbEventToEvent({ dbEvent: event }) // won't account for sort order
    }
  }
}

export default IdStrategy
