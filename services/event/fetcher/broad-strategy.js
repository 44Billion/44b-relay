import deta from '#services/db/index.js'
import { dbEventToEvent } from '#helpers/event.js'
import { shuffle } from '#helpers/array.js'
import CartesianProductBuilder from '#services/event/fetcher/helpers/cartesian-product-builder.js'
import getQueryKeyWithOperator from '#services/event/fetcher/helpers/get-query-key-with-operator.js'

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 200
class BroadStrategy {
  static doesWorkFor () { return true }

  static run (filter) {
    new this(filter).run()
  }

  constructor (filter) {
    Object.assign(this, { filter })
  }

  async * run () {
    const filter = this
    const limit = Math.min(MAX_LIMIT, filter.limit ?? DEFAULT_LIMIT)
    const eventTable = 'events'

    // andFields are since, until and Generic Tag Queries
    const isOrSet = ((orKeys = { ids: true, authors: true, kinds: true }) => key => !!orKeys[key])()
    const { orSets, andFields } = Object.entries(filter).reduce((memo, [k, v]) => {
      // as there is maxOrQueryItems = 1500, we shuffle each array of values
      if (isOrSet(k)) memo.orSets.push([k, shuffle(v)])
      else memo.andFields[getQueryKeyWithOperator(k, v)] = v
      return memo
    }, { orSets: [], andFields: {} })

    const query = this.getOrQuery(orSets, andFields)

    let items
    let last
    let iterationsLeft = 100 // so to not scan all DB (1MB of rows per iteration)
    do {
      ({ items, last } = await deta.Base(eventTable).fetch(query, { limit }))
      for (const event of items) { yield dbEventToEvent({ dbEvent: event }) }
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

export default BroadStrategy
