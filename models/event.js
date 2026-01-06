import deta, { generateKey, keyToDate } from '#services/db/deta.js'
import { isReplaceableEvent, isAddressableEvent, getAuthorPubkey } from '#helpers/event.js'

async function getReplaceableEventsTableKey (event) {
  const { kind, tags } = event
  let keySuffix = ''
  if (isAddressableEvent(event)) {
    const dTag = tags.find(v => v[0] === 'd')?.[1] || ''
    keySuffix = `:d:${dTag}`
  }
  return `${kind}${keySuffix}`
}

async function createEventMeta (nextDbEvent) {
  let replaceable_event_key
  if (isReplaceableEvent(nextDbEvent) || isAddressableEvent(nextDbEvent)) {
    replaceable_event_key = getReplaceableEventsTableKey(nextDbEvent)
    if (!replaceable_event_key) throw new Error('Missing replaceable_event_key')
  }
  let { key: event_key, id: key, author, kind, published_at, __expires } = nextDbEvent
  if (!key || !event_key) throw new Error('Missing id or event_key')
  if (!author) throw new Error('Missing author')
  if (published_at === undefined) throw new Error('Missing published_at')

  // don't let a too far ahead event hide from deleteStaleEvents
  const THREE_MONTHS_AHEAD_SECONDS = Date.now() / 1000 + 60 * 60 * 24 * 30 * 3
  if (published_at > THREE_MONTHS_AHEAD_SECONDS) published_at = THREE_MONTHS_AHEAD_SECONDS
  const usefulEventAttrs = {
    author, // useful for IdStrategy
    // 'kind',
    published_at, // useful to recover eventPublishedAts key
    __expires
  }

  try {
    await deta.Base('eventMeta').insert({ ...usefulEventAttrs, key, event_key, ...(replaceable_event_key && { replaceable_event_key }) })
    // older first
    const eventPublishedAtKey = generateKey({ timestampMs: published_at * 1000, ascending: true, id: key })
    // use to delete too old events when needing space (filter out premium pubkeys and maybe filter out some kinds like metadata)
    await deta.Base('eventPublishedAts').insert({ key: eventPublishedAtKey, author, kind, __expires }) // , id: key }) use keyToId to recover id
  } catch (err) {
    console.log(err.stack)
  }
}

async function deleteEventMeta ({ key, eventPublishedAtKey }) {
  try {
    if (!eventPublishedAtKey) {
      const dbEvent = await deta.Base('eventMeta').get(key)
      if (!dbEvent) return
      eventPublishedAtKey = generateKey({ timestampMs: dbEvent.published_at * 1000, ascending: true, id: key })
    }
    await deta.Base('eventMeta').delete(key)
    await deta.Base('eventPublishedAts').delete(eventPublishedAtKey)
  } catch (err) {
    console.log(err.stack)
  }
}

// Used at saver and when authenticating and subscribing
const keepTrackOfPubkey = (() => {
  const ONE_DAY = 1000 * 60 * 60 * 24

  function getActiveDaysConfig ({ active_days, day_key, nextKey, now }) {
    if (active_days === undefined || day_key === undefined) return { active_days: 1, day_key: nextKey }

    const then = keyToDate(day_key, { ascending: true })
    now ??= keyToDate(nextKey, { ascending: true })
    const delta = now.getTime() - then.getTime()

    if (delta > ONE_DAY * 14) return { active_days: Math.max(1, Math.round(active_days / 2)), day_key: nextKey } // day_key too old to consider, so almost reset
    if (delta > ONE_DAY) return { active_days: active_days++, day_key: nextKey }
    return { active_days, day_key } // don't change if less than one day
  }

  async function updateActiveAt ({ tablePubkey, author }) {
    const key = tablePubkey.pubkey_active_at_key
    if (key === undefined) throw new Error('No pubkey_active_at_key')

    const nowDate = new Date()
    const nextKey = generateKey({ timestampMs: nowDate.getTime(), ascending: true })
    const previousPubkeyActiveAt = (await deta.Base('pubkeyActiveAts').get(key) || {})
    const { active_days, day_key } = previousPubkeyActiveAt
    const config = await getActiveDaysConfig({ active_days, day_key, nextKey, now: nowDate })
    if (previousPubkeyActiveAt) await deta.Base('pubkeyActiveAts').delete(key)
    await deta.Base('pubkeyActiveAts').put({ author, ...config }, nextKey) // faster and avoid error if exists
    await deta.Base('tablePubkeys').update({ pubkey_active_at_key: nextKey }, author)
  }

  return async function keepTrackOfPubkey ({ ws, action, event } = {}) {
    switch (action) {
      case 'delete': return
      case 'authenticate':
      case 'subscribe': {
        const author = ws.nostr.pubkey
        if (!author) return
        // We will only keep track of pubkeyActiveAts for those that had ever published an event (has tablePubkeys)
        // so to not bloat db with spam auth
        // tablePubkeys so to be able to delete tables that have appended pubkey to their names
        const tablePubkey = await deta.Base('tablePubkeys').get(author)
        if (!tablePubkey) return

        await updateActiveAt({ tablePubkey, author })
        return
      }
      case 'create':
      case 'update': {
        if (!event) throw new Error('No event')
        const eventAuthor = getAuthorPubkey(event)
        const tablePubkey = await deta.Base('tablePubkeys').get(eventAuthor)

        const isNew = !tablePubkey
        if (isNew) {
          // if it's new, add "active at" even if it is an event posted not from the authed user
          try {
            const pubkey_active_at_key = generateKey({ timestampMs: Date.now(), ascending: true })
            await deta.Base('tablePubkeys').put({ pubkey_active_at_key }, eventAuthor)
            const config = getActiveDaysConfig({ nextKey: pubkey_active_at_key })
            await deta.Base('pubkeyActiveAts').put({ author: eventAuthor, ...config }, pubkey_active_at_key)
          } catch (err) { console.log(err.stack) }
        } else {
          const authAuthor = ws.nostr.pubkey
          // don't update pubkey_active_at_key if not the author
          if (!authAuthor || authAuthor !== event.pubkey) return
          await updateActiveAt({ tablePubkey, author: eventAuthor })
        }
      }
    }
  }
})()

export {
  getReplaceableEventsTableKey,
  createEventMeta,
  deleteEventMeta,
  keepTrackOfPubkey
}
