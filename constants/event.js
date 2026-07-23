import { eventKinds } from 'libp2r2p/kind'

// Kind-5 events use this same window for local retention and unauthenticated publishing.
const OLD_EVENT_AUTH_REQUIRED_AFTER_SECONDS = 60 * 10

// these are 1:1 pubkey - event kind
// so that data don't get lost below newer content / deleted
// const eventKindTo1To1Table = {
//   [eventKinds.METADATA]: 'metadata',
//   [eventKinds.FOLLOWS]: 'follows'
// }

// other tables:
// events (latest)
// - key === desc timestamp
// - don't trim old events as maybe deta make fetch better (not many round trips)
// events181d2811 (eventsAuthorPubkey when one is fetching by author)
// - key === desc timestamp
// - useful to check fast for user activity
// - at client, fetch one specific event by id but also by { ids: [a], authors: [x] } so to force use of table
// replaceableEvents127833 (all 1:1 pubkey : event kind, so that data don't get lost below newer content / deleted)
// - key === kind + :d: + dValue
// - useful to check for metadata so that data they don't get lost below newer content / deleted
// - at client, fetch one specific event by kind and d tag but also by { ..., authors: [x] } so to force use of table
// pubkeys
// - key === authorPubkey (and delegatee) so to keep track of all events181d2811 and replaceableEvents127833
// - last_active_at (so to delete inative accounts - no write nor read)

const eventTags = {
  ADDRESS: 'a', // https://github.com/nostr-protocol/nips/blob/master/23.md
  CHALLENGE: 'challenge',
  DEDUPLICATION: 'd',
  DELEGATION: 'delegation',
  EVENT: 'e',
  EXPIRATION: 'expiration',
  GEOLOCATION: 'g', // not used by anyone yet ["g", "DE", "country"] or ["g", "ww8p1r4t8", "geohash"]
  HASHTAG: 't',
  IMAGE: 'image', // https://github.com/nostr-protocol/nips/blob/master/23.md
  KIND: 'k',
  LANGUAGE: 'l', // https://github.com/nostr-protocol/nips/blob/master/12.md
  NONCE: 'nonce',
  PUBKEY: 'p',
  PUBLISHED_AT: 'published_at', // https://github.com/nostr-protocol/nips/blob/master/23.md
  RELAY: 'relay',
  REFERENCE: 'r',
  SUBJECT: 'subject',
  SUMMARY: 'summary', // https://github.com/nostr-protocol/nips/blob/master/23.md
  SENDER: 's',
  TITLE: 'title' // https://github.com/nostr-protocol/nips/blob/master/23.md
}

const RELAY_OWNED_KINDS = new Set([
  eventKinds.READ_WRITE_RELAYS, // 10002
  eventKinds.MAIN_SITE_MANIFEST,
  eventKinds.NEXT_SITE_MANIFEST,
  eventKinds.DRAFT_SITE_MANIFEST
])

const MANIFEST_KINDS = new Set([
  eventKinds.MAIN_SITE_MANIFEST,
  eventKinds.NEXT_SITE_MANIFEST,
  eventKinds.DRAFT_SITE_MANIFEST
])

export {
  OLD_EVENT_AUTH_REQUIRED_AFTER_SECONDS,
  eventKinds,
  // eventKindTo1To1Table,
  eventTags,
  MANIFEST_KINDS,
  RELAY_OWNED_KINDS
}
