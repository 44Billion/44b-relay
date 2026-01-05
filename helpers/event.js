import { eventKinds, eventTags } from '#constants/event.js'
import { isType } from '#helpers/shared.js'
import { pick } from '#helpers/object.js'
import EventValidator from '#services/event/validator.js'
import { generateKey } from '#services/db/index.js'

// NIP-16: Event Treatment - https://github.com/nostr-protocol/nips/blob/master/16.md
function isRegularEvent (event) { return isType(event.kind, 'number') && event.kind >= 1000 && event.kind < 10000 }
function isReplaceableEvent (event) {
  return isType(event.kind, 'number') && (
    event.kind === eventKinds.METADATA ||
    event.kind === eventKinds.RECOMMEND_RELAY || // because it is not the best tool for the job, we let just 1 per pubkey
    event.kind === eventKinds.FOLLOWS ||
    // event.kind === eventKinds.CHANNEL_METADATA || // one per pubkey per e tag value
    (event.kind >= 10000 && event.kind < 20000)
  )
}
function isEphemeralEvent (event) { return isType(event.kind, 'number') && event.kind >= 20000 && event.kind < 30000 }
function isParameterizedReplaceableEvent (event) { return isType(event.kind, 'number') && (event.kind === eventKinds.REACTION || (event.kind >= 30000 && event.kind < 40000)) }
function isKnownEventKind (kind) {
  return isType(kind, 'number') &&
    (
      (kind >= 0 && kind < 8) ||
      (kind >= 40 && kind < 50) ||
      (kind >= 1000 && kind < 30000)
    )
}

function isExpiredEvent (event) {
  let expiration
  try { expiration = parseInt(event.tags.find(v => v[0] === eventTags.EXPIRATION)?.[1], 10) } catch (err) {}
  if (!isType(expiration, 'number') || expiration <= (Date.now() / 1000)) return false
}

function serializeEvent (event) {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ])
}

async function isValidEvent ({ event, clientMessage }) {
  return EventValidator.run({ event, clientMessage })
}

function getAuthorPubkey (event) {
  return event.tags.find(v => v[0] === eventTags.DELEGATION)?.[1] ?? event.pubkey
}

function isEventCopy (event) { return false }

function getPublishedAt (event) {
  // instead of event.kind === eventKinds.LONG_FORM_CONTENT we will extend it to all parameterized replaceable events
  const publishedAt = (isEventCopy(event) || isParameterizedReplaceableEvent(event)) && event.tags.find(v => v[0] === eventTags.PUBLISHED_AT)?.[1]
  return publishedAt ? parseInt(publishedAt, 10) : event.created_at
}

function getExpiration (event) {
  let expiration
  // const threeWeeks = Date.now() / 1000 + 60 * 60 * 24 * 7 * 3
  try {
    expiration = parseInt(event.tags.find(v => v[0] === 'expiration')?.[1], 10)
    if (Number.isNaN(expiration)) expiration = undefined
    // temp while we figure out how we will handle event durability
    // if (expiration === undefined || expiration > threeWeeks) expiration = threeWeeks
    return expiration
  } catch (err) {
    // don't expire
    // expiration = threeWeeks // temp while we figure out how we will handle event durability
  }
}

function getDbEventKey (event) {
  // always the same
  return generateKey({ timestampMs: getPublishedAt(event) * 1000, ascending: false, id: event.id })
}

function eventToDbEvent ({ event, key }) {
  key ||= getDbEventKey(event)
  // - #e, #p, #any1...#anyN (each is an array of string values)
  const genericTagQueries = event.tags
    .filter(v => /^#[A-Za-z]$/.test(v[0]))
    .reduce((memo, item) => {
      memo[item[0]] ??= []
      memo[item[0]].push(item[1])
      return memo
    }, {})
  const expiration = getExpiration(event)

  return {
    ...pick(event, [
      'id',
      'pubkey', // not author (author can be the delegated one)
      'created_at',
      'kind',
      'tags', // original
      'content',
      'sig'
    ]),
    key,
    author: getAuthorPubkey(event),
    published_at: getPublishedAt(event),
    ...genericTagQueries,
    ...(expiration && { __expires: expiration })
  }
}

function dbEventToEvent ({ dbEvent }) {
  return pick(dbEvent, [
    'id',
    'pubkey', // not author (author can be the delegated one)
    'created_at',
    'kind',
    'tags', // original
    'content',
    'sig'
  ])
}

export {
  isRegularEvent,
  isReplaceableEvent,
  isParameterizedReplaceableEvent,
  isEphemeralEvent,
  isKnownEventKind,
  isExpiredEvent,
  isValidEvent,
  serializeEvent,
  getAuthorPubkey,
  getPublishedAt,
  eventToDbEvent,
  dbEventToEvent,
  getDbEventKey
}
