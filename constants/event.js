const eventKinds = {
  METADATA: 0,
  TEXT_NOTE: 1,
  RECOMMEND_RELAY: 2, // removed
  FOLLOWS: 3,
  ENCRYPTED_DIRECT_MESSAGE: 4,
  DELETION: 5,
  REPOST: 6, // also add to aggregates table? { key: eventid }
  REACTION: 7, // also add to aggregates table?
  CHANNEL_CREATE: 40,
  CHANNEL_METADATA: 41,
  CHANNEL_MESSAGE: 42,
  CHANNEL_HIDE_MESSAGE: 43,
  CHANNEL_MUTE_USER: 44,
  MUTE_LIST: 10000,
  PINNED_NOTES: 10001,
  READ_WRITE_RELAYS: 10002,
  BOOKMARKS: 10003,
  COMMUNITIES: 10004,
  PUBLIC_CHATS: 10005,
  BLOCKED_RELAYS: 10006,
  SEARCH_RELAYS: 10007,
  SIMPLE_GROUPS: 10009,
  RELAY_FEEDS: 10012,
  INTERESTS: 10015,
  MEDIA_FOLLOWS: 10020,
  EMOJIS: 10030,
  DM_RELAYS: 10050,
  GOOD_WIKI_AUTHORS: 10101,
  GOOD_WIKI_RELAYS: 10102,
  AUTH: 22242,
  FOLLOW_SET: 30000,
  LIST: 30001, // deprecated
  RELAY_SET: 30002,
  BOOKMARK_SET: 30003,
  CURATION_SET: 30004,
  VIDEO_CURATION_SET: 30005,
  PICTURE_CURATION_SET: 30006,
  KIND_MUTE_SET: 30007,
  INTEREST_SET: 30015,
  LONG_FORM_CONTENT: 30023,
  EMOJI_SET: 30030,
  RELEASE_ARTIFACT_SET: 30063,
  APP_CURATION_SET: 30267,
  CALENDAR: 31924,
  BINARY_DATA_CHUNK: 34600,
  MAIN_APP_STALL: 37348,
  NEXT_APP_STALL: 37349,
  DRAFT_APP_STALL: 37350,
  MAIN_APP_BUNDLE: 37448, // stable
  NEXT_APP_BUNDLE: 37449, // insider
  DRAFT_APP_BUNDLE: 37450, // vibe coded preview
  STARTER_PACK: 39089,
  MEDIA_STARTER_PACK: 39092
}

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
  LANGUAGE: 'l', // https://github.com/nostr-protocol/nips/blob/master/12.md
  NONCE: 'nonce',
  PUBKEY: 'p',
  PUBLISHED_AT: 'published_at', // https://github.com/nostr-protocol/nips/blob/master/23.md
  RELAY: 'relay',
  REFERENCE: 'r',
  SUBJECT: 'subject',
  SUMMARY: 'summary', // https://github.com/nostr-protocol/nips/blob/master/23.md
  TITLE: 'title' // https://github.com/nostr-protocol/nips/blob/master/23.md
}

export {
  eventKinds,
  // eventKindTo1To1Table,
  eventTags
}
