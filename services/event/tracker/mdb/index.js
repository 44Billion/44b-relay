import { HyperLogLog as HLL } from 'nostr-hll/hyperloglog.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToBase64 } from '#helpers/base64.js'
import { eventKinds } from '#constants/event.js'
import { queueOps } from '#services/event/maintainer/mdb/index.js'

// Cache to hold HLL objects in memory before flushing
// Map<Pubkey, HLL>
const requestedPubkeysCache = new Map()
const utf8Encoder = new TextEncoder()

// These kinds may have been requested just
// to enhance the profile of a spammer account
// on a thread UI, not exactly because the vieweing user
// is on the other user's profile page. The former
// isn't interesting for us to track.
export const uninterestedIn = {
  kinds: {
    [eventKinds.METADATA]: true, // 0
    [eventKinds.RELAY_LIST_METADATA]: true // 10002
  }
}
export function getFilterInterests ({ filters }) {
  const interestingIds = {}
  const interestingPubkeys = new Set()
  for (const filter of filters) {
    const hasAuthors = filter.authors && filter.authors.length > 0
    const hasIds = filter.ids && filter.ids.length > 0
    if (hasAuthors) {
      for (const author of filter.authors) {
        interestingPubkeys[author] = true
      }
    // Only consider ids if there are no authors in the filter
    } else if (hasIds) {
      for (const id of filter.ids) {
        interestingIds[id] = true
      }
    }
  }
  return { ids: interestingIds, pubkeys: interestingPubkeys }
}

export function trackRequestedPubkeys ({ pubkeys, ip }) {
  for (const pubkey of pubkeys) {
    let hll = requestedPubkeysCache.get(pubkey)
    if (!hll) {
      hll = new HLL(0)
      requestedPubkeysCache.set(pubkey, hll)
    }
    hll.add(sha256(utf8Encoder.encode(ip)))
  }
}

export async function flushRequestedPubkeysToMDB () {
  if (requestedPubkeysCache.size === 0) return

  const currentCache = new Map(requestedPubkeysCache)
  requestedPubkeysCache.clear()

  const ops = []
  for (const [pubkey, hll] of currentCache.entries()) {
    ops.push({
      targetKey: pubkey,
      type: 'mergeHll',
      data: { hll: bytesToBase64(hll.getRegisters()) }
    })
  }

  await queueOps(ops)
}
