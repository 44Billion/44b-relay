import deta from '#services/db/index.js'
import { isReplaceableEvent, isParameterizedReplaceableEvent, getPublishedAt, dbEventToEvent } from '#helpers/event.js'
import { doesMatchASubscriptionFilter } from '#helpers/subscription.js'
import { eventTags } from '#constants/event.js'

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 200
class ReplaceableStrategy {
  static doesWorkFor (filter) {
    const regex = /^[0-9a-f]{64}$/
    return !!filter.authors?.length &&
      filter.authors.every(v => regex.test(v)) && (
      (
        filter.kinds?.length === 1 &&
        isParameterizedReplaceableEvent({ kind: filter.kinds[0] }) &&
        [0, 1].includes(filter[`#${eventTags.DEDUPLICATION}`] || []).length
      ) || (
        !!filter.kinds?.length &&
        filter.kinds.every(v => isReplaceableEvent({ kind: v }))
      )
    )
  }

  static run (filter) {
    new this(filter).run()
  }

  constructor (filter) {
    Object.assign(this, { filter })
  }

  async * run () {
    const filter = this
    const limit = Math.min(MAX_LIMIT, filter.limit ?? DEFAULT_LIMIT)
    const { authors, kinds, ...filterWithoutAuthorsAndKinds } = filter
    const filters = [filterWithoutAuthorsAndKinds]

    const isParameterized =
      filter.kinds?.length === 1 &&
      isParameterizedReplaceableEvent({ kind: filter.kinds[0] }) &&
      [0, 1].includes(filter[`#${eventTags.DEDUPLICATION}`] || []).length
    const keySuffix = isParameterized ? `:d:${(filter[`#${eventTags.DEDUPLICATION}`] || [])[0] ?? ''}` : ''

    let author
    let kind
    const events = []
    let isSorted = false

    for (author of filter.authors) {
      const eventTable = `replaceableEvents${author}`

      for (kind of filter.kinds) {
        const key = `${kind}${keySuffix}`
        const event = await deta.Base(eventTable).get(key)
        if (!event || !doesMatchASubscriptionFilter({ filters, event })) continue

        if (event.published_at === undefined) event.published_at = getPublishedAt(event)
        events.push(event)
        if (events.length <= limit) continue

        events.sort((a, b) => b.published_at - a.published_at)
        isSorted ||= true
        events.pop()
      }
    }
    if (!isSorted) events.sort((a, b) => b.published_at - a.published_at)

    let event
    for (event of events) { yield dbEventToEvent({ dbEvent: event }) }
  }
}

export default ReplaceableStrategy
