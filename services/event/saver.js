import { isReplaceableEvent, isParameterizedReplaceableEvent, eventToDbEvent, getAuthorPubkey, getDbEventKey } from '#helpers/event.js'
import { eventKinds, eventTags } from '#constants/event.js'
import deta from '#services/db/index.js'
import { getReplaceableEventsTableKey, createEventMeta, deleteEventMeta, keepTrackOfPubkey } from '#models/event.js'

export default class EventSaver {
  static run ({ ws, event, ip }) {
    return new this({ ws, event, ip }).save()
  }

  constructor ({ ws, event, ip }) {
    Object.assign(this, { ws, event, ip, receivedAt: Date.now() })
  }

  keepTrackOfPubkey ({ isPublishing } = {}) {
    const { ws, event } = this
    const action = isPublishing
      ? 'create' // 'create' or 'update' lead to same outcome
      : 'delete'
    return keepTrackOfPubkey({ ws, action, event })
  }

  getDbEventExtraAttrs () {
    return { ip: this.ip, received_at: this.receivedAt }
  }

  // event is expected to already be checked that it isn't expired nor ephemeral
  async save () {
    const { event } = this

    if (event.kind === eventKinds.DELETION) {
      try {
        // delete 100 in a row at max to avoid abuse
        const ids = event.tags.filter(v => v[0] === eventTags.EVENT).slice(0, 100).map(v => v[1])
        if (ids.length === 0) return { isSuccess: true, isDuplicate: false, message: '' }

        const author = getAuthorPubkey(event)
        // vvv won't use findDbEventKeysByIdByAuthor cause table eventMeta has (key: eventId, event_key: getDbEventKey(event), author)
        // const keysToDeleteAsyncGenerator = this.findDbEventKeysByIdByAuthor({ ids, author })
        // for await (const keyToDelete of keysToDeleteAsyncGenerator) {
        //   const dbEvent = await deta.Base(`events${author}`).get(keyToDelete) || await deta.Base('events').get(keyToDelete)
        //   if (!dbEvent) continue

        //   if (isReplaceableEvent(dbEvent) || isParameterizedReplaceableEvent(dbEvent)) {
        //     const shortcutTableName = `replaceableEvents${author}`
        //     const shortcutTableKey = getReplaceableEventsTableKey(dbEvent)
        //     await deta.Base(shortcutTableName).delete(shortcutTableKey)
        //   }
        //   await deta.Base('events').delete(keyToDelete)
        //   await deta.Base(`events${author}`).delete(keyToDelete)
        // }
        for (const id of await ids) {
          const eventMeta = await deta.Base('eventMeta').get(id)
          if (!eventMeta) continue

          const { event_key, replaceable_event_key, author: metaAuthor } = eventMeta
          if (author !== metaAuthor) continue // not allowed

          if (replaceable_event_key) await deta.Base(`replaceableEvents${author}`).delete(replaceable_event_key)
          await deta.Base('events').delete(event_key)
          await deta.Base(`events${author}`).delete(event_key)
          await deleteEventMeta({ key: id })
        }

        await this.keepTrackOfPubkey({ isPublishing: false })
        return { isSuccess: true, isDuplicate: false, message: '' }
      } catch (err) {
        console.error(err)
        return { isSuccess: false, isDuplicate: false, message: 'error: database couldn\'t save it' }
      }
    }

    let errorMessage
    if (isReplaceableEvent(event) || isParameterizedReplaceableEvent(event)) {
      const isReaction = event.kind === eventKinds.REACTION
      let softDTag
      if (isReaction) {
        // reaction acts like parameterized replaceable event, but isn't documented as such https://github.com/nostr-protocol/nips/blob/master/25.md
        // most clients won't add d tag https://github.com/nostr-protocol/nips/pull/264
        const hasDTag = !!event.tags.find(v => v[0] === eventTags.DEDUPLICATION)?.[1]
        if (!hasDTag) {
          const reversedTags = [...event.tags].reverse()
          softDTag =
            reversedTags.find(v => [eventTags.EVENT, eventTags.ADDRESS].includes(v[0])) ||
            reversedTags.find(v => v[0] === eventTags.PUBKEY) // if reacting to profile
          const softDTagSlice = softDTag ? softDTag.slice(1) : [''] // keep relay url
          softDTag = [eventTags.DEDUPLICATION, ...softDTagSlice]
          event.tags.push(softDTag)
        }
      }
      // so to get dbEventFromShortcutTable?.event_key (events table key reference)
      // and validate event against dbEvent inside getValidationErrorMessage
      const dbEventFromShortcutTable = await this.findDbEventByReplaceableDataByShortcut()
      if ((errorMessage = this.getValidationErrorMessage({ dbEvent: dbEventFromShortcutTable }))) return { isSuccess: false, isDuplicate: false, message: errorMessage }

      try {
        if (dbEventFromShortcutTable?.id) await deleteEventMeta({ key: dbEventFromShortcutTable.id })
        const nextDbEvent = { ...eventToDbEvent({ event }), ...this.getDbEventExtraAttrs() }
        await createEventMeta(nextDbEvent)

        // remove softDTag after calculating nextDbEvent (after adding '#d' field)
        if (isReaction && softDTag !== undefined) nextDbEvent.tags = nextDbEvent.tags.slice(0, nextDbEvent.tags.length - 1)
        const shortcutTableKey = dbEventFromShortcutTable?.key ?? getReplaceableEventsTableKey(this.event) // same
        const author = getAuthorPubkey(event)
        const shortcutTableName = `replaceableEvents${author}`
        // delete so to update the key (can't .update the key)
        // the key is the only way to (auto) sort using deta
        if (dbEventFromShortcutTable?.event_key) {
          await deta.Base('events').delete(dbEventFromShortcutTable?.event_key)
          await deta.Base(`events${author}`).delete(dbEventFromShortcutTable?.event_key)
        }
        await deta.Base(shortcutTableName).put({ ...nextDbEvent, key: shortcutTableKey, event_key: nextDbEvent.key })
        await deta.Base('events').put(nextDbEvent)
        await deta.Base(`events${author}`).put(nextDbEvent)

        await this.keepTrackOfPubkey({ isPublishing: true })
        return { isSuccess: true, isDuplicate: false, message: '' }
      } catch (err) {
        console.error(err)
        return { isSuccess: false, isDuplicate: false, message: 'error: database couldn\'t save it' }
      }
    }

    // const dbEvent = await this.findDbEventByIdByAuthor()
    const dbEventKey = getDbEventKey(this.event)
    const author = getAuthorPubkey(event)
    let dbEvent = await deta.Base(`events${author}`).get(dbEventKey)
    if (dbEvent) return { isSuccess: true, isDuplicate: true, message: 'duplicate: id already in use' }
    else if ((dbEvent = await deta.Base('events').get(dbEventKey))) {
      try { await deta.Base(`events${author}`).insert(dbEvent) } catch (err) { console.log('Race condition. Moving on') }
      return { isSuccess: true, isDuplicate: true, message: 'duplicate: id already in use' }
    }
    if ((errorMessage = this.getValidationErrorMessage())) return { isSuccess: false, isDuplicate: false, message: errorMessage }

    try {
      const nextDbEvent = { ...eventToDbEvent({ event }), ...this.getDbEventExtraAttrs() }
      await createEventMeta(nextDbEvent)

      const author = getAuthorPubkey(event)
      await deta.Base('events').insert(nextDbEvent)
      await deta.Base(`events${author}`).insert(nextDbEvent)
      await this.keepTrackOfPubkey({ isPublishing: true })
      return { isSuccess: true, isDuplicate: false, message: '' }
    } catch (err) {
      // in fact, deta key already in use
      return { isSuccess: true, isDuplicate: true, message: 'duplicate: id already in use' }
    }
  }

  // used by delete event if key is unknown
  async * findDbEventKeysByIdByAuthor ({ ids, author }) {
    const queries = ids.map(id => ({ id }))

    let last, items
    let itemCount = 0
    let iterationsLeft = 100 // so to not scan all DB (1MB of rows per iteration)
    do {
      ({ items, last } = await deta.Base(`events${author}`).fetch(queries, { limit: 1, last }))
      if (items.length > 0) {
        itemCount += items.length
        let item
        for (item of items) { yield item.key }
      }
    } while (itemCount.length < ids.length && last && --iterationsLeft > 0)
  }

  // prefer using getDbEventKey instead to get by key
  async findDbEventByIdByAuthor () {
    const { event, event: { id } } = this
    const author = getAuthorPubkey(event)
    let last, items, item
    let iterationsLeft = 100 // so to not scan all DB (1MB of rows per iteration)
    do {
      ({ items, last } = await deta.Base(`events${author}`).fetch({ id }, { limit: 1, last }))
      if (items[0]) item = items[0]
    } while (!item && last && --iterationsLeft > 0)
    return item ?? null
  }

  // won't be used as we will use eventsPubkeyxyz table in findDbEventByIdByAuthor
  // may not find it although it is on DB (maxIterationCount)
  async findDbEventById () {
    const { id } = this.event
    let last, items, item
    let iterationsLeft = 100 // so to not scan all DB (1MB of rows per iteration)
    do {
      ({ items, last } = await deta.Base('events').fetch({ id }, { limit: 1, last }))
      if (items[0]) item = items[0]
    } while (!item && last && --iterationsLeft > 0)
    return item ?? null
  }

  findDbEventByReplaceableDataByShortcut () {
    const { event } = this
    const author = getAuthorPubkey(event)
    const tableName = `replaceableEvents${author}`
    const key = getReplaceableEventsTableKey(event)
    return deta.Base(tableName).get(key)
  }

  // won't be used as we will use replaceableEventsPubkeyxyz table in findDbEventByReplaceableDataByShortcut
  async findDbEventByReplaceableData () {
    const { event, event: { kind, tags } } = this
    const author = getAuthorPubkey(event)
    const query = { kind, author } //, 'created_at?lt': event.created_at } do this check outside at .save
    if (isParameterizedReplaceableEvent(event)) {
      const dTag = tags.find(v => v[0] === eventTags.DEDUPLICATION)?.[1]
      // won't fallback to '' dTag cause db event won't have #d attr
      if (dTag !== undefined) query['#d?contains'] = dTag
      // do this check outside at .save
      // const publishedAtTag = tags.find(v => v[0] === eventTags.PUBLISHED_AT)?.[1]
      // if (publishedAtTag !== undefined) query['#publishedAtTag?contains'] = publishedAtTag
    }
    let last, items, item
    let iterationsLeft = 100 // so to not scan all DB (1MB of rows per iteration)
    do {
      ({ items, last } = await deta.Base('events').fetch(query, { limit: 1, last }))
      if (items[0]) item = items[0]
    } while (!item && last && --iterationsLeft > 0)
    return item ?? null
  }

  // when replaceble event validation (needs dbEvent) should be here instead of at EventValidator
  getValidationErrorMessage ({ dbEvent } = {}) {
    if (!dbEvent) return // not replaceable event

    const { event } = this
    if (event.created_at <= dbEvent.created_at) return 'error: older than or equal to saved one'

    const eventPublisedAt = event.tags.find(v => v[0] === eventTags.PUBLISHED_AT)?.[1]
    const dbEventPublisedAt = dbEvent?.tags?.find?.(v => v[0] === eventTags.PUBLISHED_AT)?.[1]
    if (
      (event.kind === eventKinds.LONG_FORM_CONTENT && eventPublisedAt === undefined) || (
        dbEventPublisedAt &&
        eventPublisedAt !== dbEventPublisedAt
      )
    ) return 'error: wrong publication date'
  }
}
