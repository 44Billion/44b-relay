import { eventKinds, eventTags } from '#constants/event.js'
import { isType } from '#helpers/shared.js'
import { pick } from '#helpers/object.js'
import EventValidator from '#services/event/validator.js'
import { generateKey } from '#services/db/deta.js'

function isRegularEvent (event, {
  isReplaceable = isReplaceableEvent(event),
  isAddressable = isAddressableEvent(event)
} = {}) {
  return !isReplaceable && !isAddressable
}
function isReplaceableEvent (event) {
  return event.kind === eventKinds.METADATA ||
    // event.kind === eventKinds.RECOMMEND_RELAY || // because it is not the best tool for the job, we let just 1 per pubkey
    event.kind === eventKinds.FOLLOWS ||
    // event.kind === eventKinds.CHANNEL_METADATA || // one per pubkey per e tag value
    (event.kind >= 10000 && event.kind < 20000) ||
    // experimental: for replaceable check based on d tag,
    // consider just the first tags to avoid processing too many tags
    (event.tags[0]?.[0] === 'd' && event.tags[0][1] === '')
}
function isAddressableEvent (event) {
  return isType(event.kind, 'number') && (
    (event.kind >= 30000 && event.kind < 40000) ||
    (event.tags[0]?.[0] === 'd' && event.tags[0][1].length > 0)
  )
}
function isEphemeralEvent (event) {
  if (event.kind >= 20000 && event.kind < 30000) return true
  // experimental: for ephemeral check based on expiration tag,
  // consider just the first two tags to avoid processing too many tags
  const expirationTag = event.tags.slice(0, 2).find(v => v[0] === eventTags.EXPIRATION)
  if (!expirationTag) return false
  return isExpiredEvent(event, { expirationTag })
}
// Limited by nip19 or else it could be 64bit unsigned int
// Good thing is we don't need to convert to string on json nor use BigInt
// Bad thing is collision resistance is lower
const kindLimit = 2 ** 32 - 1
function isKnownEventKind (kind) {
  return isType(kind, 'number') &&
    kind >= 0 &&
    kind <= kindLimit
}

function isExpiredEvent (event, { expirationTag } = {}) {
  let expiration
  try { expiration = parseInt(expirationTag || event.tags.find(v => v[0] === eventTags.EXPIRATION)?.[1], 10) } catch (_err) {}
  return (
    isType(expiration, 'number') && (
      expiration <= event.created_at ||
      expiration <= (Date.now() / 1000)
    )
  )
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
  return event.pubkey
  // return event.tags.find(v => v[0] === eventTags.DELEGATION)?.[1] ?? event.pubkey
}

// function isEventCopy (_event) { return false }

function getPublishedAt (event) {
  return event.created_at
  // // instead of event.kind === eventKinds.LONG_FORM_CONTENT we will extend it to all parameterized replaceable events
  // const publishedAt = (isEventCopy(event) || isAddressableEvent(event)) && event.tags.find(v => v[0] === eventTags.PUBLISHED_AT)?.[1]
  // return publishedAt
  //   ? (() => {
  //       let result
  //       try { result = parseInt(publishedAt, 10) } catch (_err) {}
  //       if (Number.isNaN(result)) return event.created_at
  //       return result
  //     })()
  //   : event.created_at
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
  } catch (_err) {
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
  isAddressableEvent,
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
