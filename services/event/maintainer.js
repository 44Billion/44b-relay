import deta, { keyToDate, keyToId } from '#services/db/index.js'
import { deleteEventMeta } from '#models/event.js'
const ONE_DAY = 1000 * 60 * 60 * 24

// TODO: filter out premium pubkeys and maybe filter out some kinds like metadata
async function deleteStaleEvents (ltDays = 30 * 3) {
  let didntFindTooRecent = true
  let items, last
  do {
    ({ items, last } = await deta.Base('eventPublishedAts').fetch({}))
    for (const item of items) {
      const { key: eventPublishedAtKey, author /* , kind */ } = item
      const publishedAt = keyToDate(eventPublishedAtKey, { ascending: true })
      // we expect it to be asc sorted by date (key) so older first
      if (publishedAt.getTime() > (Date.now() - ONE_DAY * ltDays)) { didntFindTooRecent = false; break }

      // TODO: filter out premium pubkeys and maybe filter out some kinds like metadata
      const isPayingCustomerOrWhitelisted = pubkey => false
      if (isPayingCustomerOrWhitelisted(author)) continue

      const id = keyToId(eventPublishedAtKey)
      const { event_key, replaceable_event_key } = await deta.Base('eventMeta').get(id)
      if (replaceable_event_key !== undefined) await deta.Base(`replaceableEvents${author}`).delete(replaceable_event_key)
      await deta.Base('events').delete(event_key)
      await deta.Base(`events${author}`).delete(event_key)

      // don't have luxury of not risking losing cursor position
      // as will have to cycle to delete either way
      // OR create a table deletedEventPublishedAts and cycle through it
      await deleteEventMeta({ key: id, eventPublishedAtKey })
    }
  } while (
    last &&
    didntFindTooRecent
  )
}

// TODO: filter out premium pubkeys
// Use this only when deleteBase is available
async function deleteStaleAccounts (ltDays = 15) {
  async function deleteAccountEvents (author) {
    let items, last, item
    do {
      ({ items, last } = await deta.Base(`events${author}`).fetch({ 'is_deleted?ne': true }))
      for (item of items) {
        await deta.Base('events').delete(item.key)
        await deleteEventMeta({ key: item.id })

        // don't really delete so to not risk losing cursor position
        await deta.Base(`events${author}`).update({ is_deleted: true }, item.key)
      }
    } while (last)

    const { pubkey_active_at_key } = (await deta.Base('tablePubkeys').get(author) || {})
    if (pubkey_active_at_key !== undefined) await deta.Base('pubkeyActiveAts').delete(pubkey_active_at_key)
    await deta.Base('tablePubkeys').delete(author)

    // deleteBase doesn't exist yet https://github.com/orgs/deta/discussions/37
    // Admin says to just delete all content looping through it
    await deta.Base(`replaceableEvents${author}`).deleteBase()
    await deta.Base(`events${author}`).deleteBase()
  }

  let didntFindTooRecent = true
  let items, last
  do {
    ({ items, last } = await deta.Base('pubkeyActiveAts').fetch({}))
    for (const item of items) {
      let { key: activeAtKey, active_days, author } = item
      const activeAt = keyToDate(activeAtKey, { ascending: true })
      // we expect it to be asc sorted by date (key) so older first
      if (activeAt.getTime() > (Date.now() - ONE_DAY * ltDays)) { didntFindTooRecent = false; break }

      // TODO: filter out premium pubkeys
      const isPayingCustomerOrWhitelisted = pubkey => false
      if (isPayingCustomerOrWhitelisted(author)) continue
      const delta = Date.now() - activeAt.getTime()
      // v won't delete accounts too fast
      if (active_days === 1) { active_days = 30 * 2 }
      if (active_days > 1 && active_days < 30 * 6) { active_days = 30 * 6 }
      // ^ won't delete accounts too fast

      const maxDelta = ONE_DAY * 3 + Math.min(ONE_DAY * 30 * 6 - 3, (active_days - 1))
      if (delta <= maxDelta) continue

      await deleteAccountEvents(author)
    }
  } while (
    last &&
    didntFindTooRecent
  )
}

export {
  deleteStaleEvents,
  deleteStaleAccounts // Use this only when deleteBase is available
}
