import deta from '#services/db/index.js'
import { isReplaceableEvent, getPublishedAt, dbEventToEvent } from '#helpers/event.js'
import { shuffle } from '#helpers/array.js'
import CartesianProductBuilder from '#services/event/fetcher/helpers/cartesian-product-builder.js'
import getQueryKeyWithOperator from '#services/event/fetcher/helpers/get-query-key-with-operator.js'

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 200
class AuthorStrategy {
  static doesWorkFor (filter) {
    // when viewing a profile page feed
    return filter.authors?.length === 1 && /^[0-9a-f]{64}$/.test(filter.authors[0])
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
    const { authors, ...filterWithoutAuthors } = filter
    const author = authors[0]
    const eventTable = filter.kinds?.length && filter.kinds.every(v => isReplaceableEvent({ kind: v }))
      ? `replaceableEvents${author}`
      : `events${author}`

    // andFields are since, until and Generic Tag Queries
    const isOrSet = ((orKeys = { ids: true, authors: true, kinds: true }) => key => !!orKeys[key])()
    const { orSets, andFields } = Object.entries(filterWithoutAuthors).reduce((memo, [k, v]) => {
      // as there is maxOrQueryItems = 1500, we shuffle each array of values
      if (isOrSet(k)) memo.orSets.push([k, shuffle(v)])
      else memo.andFields[getQueryKeyWithOperator(k, v)] = v
      return memo
    }, { orSets: [], andFields: {} })

    const query = this.getOrQuery(orSets, andFields)

    const isAlreadyOrdered = eventTable === `events${author}`
    let events
    let isSorted
    if (!isAlreadyOrdered) {
      events = []
      isSorted = false
    }
    let items
    let last
    let iterationsLeft = 100 // so to not scan all DB (1MB of rows per iteration)
    do {
      ({ items, last } = await deta.Base(eventTable).fetch(query, { limit }))
      for (const event of items) {
        if (isAlreadyOrdered) yield dbEventToEvent({ dbEvent: event })
        else {
          if (event.published_at === undefined) event.published_at = getPublishedAt(event)
          events.push(event)
          if (events.length <= limit) continue

          events.sort((a, b) => b.published_at - a.published_at)
          isSorted ||= true
          events.pop()
        }
      }
      if (isAlreadyOrdered) return

      if (!isSorted) events.sort((a, b) => b.published_at - a.published_at)

      let event
      for (event of events) { yield dbEventToEvent({ dbEvent: event }) }
    } while (
      last &&
      --iterationsLeft > 0
    )
  }

  getOrQuery (orSets, andFields = {}) {
    let maxOrQueryItems = 1500
    const orQuery = []
    for (const cartesianProductElement of this.getCartesianProduct(orSets, andFields)) {
      orQuery.push(cartesianProductElement)
      if (--maxOrQueryItems === 0) break
    }
    return orQuery
  }

  * getCartesianProduct (orSets, andFields) {
    for (const cartesianProductElement of CartesianProductBuilder.run({ sets: orSets, keyTransformerFn: getQueryKeyWithOperator })) {
      yield { ...cartesianProductElement, ...andFields }
    }
  }
}

export default AuthorStrategy
