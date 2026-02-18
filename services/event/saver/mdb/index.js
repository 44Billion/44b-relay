import { getAuthorPubkey } from '#helpers/event.js'
import { eventKinds, eventTags } from '#constants/event.js'
import { HyperLogLog as HLL } from 'nostr-hll/hyperloglog.js'
import { base16ToBytes, bytesToBase16 } from '#helpers/base16.js'
import mdb from '#services/db/mdb.js'
import { checkStorageLimitAndPrune, queueOps } from '#services/event/maintainer/mdb/index.js'
import { eventToRecord, idToRef } from '#models/event/mapper.js'
import { getEventByRef } from '#models/event/dao.js'
import { ipToPrimaryKey } from '#helpers/mdb.js'

export default class EventSaver {
  static run ({ ws, event, ip }) {
    return new this({ ws, event, ip }).save()
  }

  constructor ({ ws, event, ip }) {
    Object.assign(this, { ws, event, ip, receivedAt: Date.now() })
  }

  async save () {
    const { event, ip } = this
    const byteSize = JSON.stringify(event).length
    const author = getAuthorPubkey(event)

    const { estimatedTotalHits: isDuplicate } = await mdb.index('events').search('', {
      filter: `id = ${mdb.toMeiliValue(event.id)}`,
      limit: 1,
      offset: mdb.constants.maxTotalHits // hack to get no v.hits
    })
    // Don't let duplicates through or else checkStorageLimitAndPrune below would add to the owner's byte usage again
    if (isDuplicate) { return { isSuccess: true, isDuplicate: true, message: 'duplicate: already have this event' } }

    // Handle Deletion Requests
    if (event.kind === eventKinds.DELETION) {
      const res = await this.handleDelete({ author })
      if (!res.isSuccess) return res
    }

    try {
      let record

      if (event.kind !== eventKinds.DELETION) {
        const getDTagFromEvent = event => {
          let dTag = event.tags.find(tag => tag[0] === eventTags.DEDUPLICATION && (tag[1] || tag[1] === ''))?.[1]
          if (
            dTag === undefined && (
              (event.kind >= 10000 && event.kind < 20000) ||
              (event.kind >= 30000 && event.kind < 40000) ||
              [0, 3].includes(event.kind)
            )
          ) dTag = ''
          return dTag
        }
        const dTag = getDTagFromEvent(event)
        const orMaybeWithAddressTag = (createdAt, address) => {
          if (dTag === undefined) return ''
          return ` OR (created_at >= ${
            mdb.toMeiliValue(createdAt)} AND indexableTags = ${mdb.toMeiliValue(`a ${address}`)})`
        }
        const deleteRequestFilter =
          `kind = ${eventKinds.DELETION} AND ` +
          `pubkey = ${mdb.toMeiliValue(author)} AND ` +
          `(indexableTags = ${mdb.toMeiliValue(`e ${event.id}`)}${orMaybeWithAddressTag(event.created_at, `${event.kind}:${event.pubkey}:${dTag}`)})`
        const { estimatedTotalHits: hasDeletionRequest } = await mdb.index('events').search('', {
          filter: deleteRequestFilter, limit: 1, offset: mdb.constants.maxTotalHits
        })
        if (hasDeletionRequest) {
          return { isSuccess: false, isDuplicate: false, message: 'invalid: the author requested the deletion of the event you just tried to store' }
        }

        if (dTag !== undefined) {
          record = eventToRecord(event, { receivedAt: Math.floor(this.receivedAt / 1000) })
          const { result: existingEvent } = await getEventByRef(record.ref)
          const hasMoreRecent =
            existingEvent && (
              existingEvent.created_at > record.created_at ||
              (existingEvent.created_at === record.created_at && existingEvent.id < record.id)
            )
          if (hasMoreRecent) {
            return { isSuccess: false, isDuplicate: false, message: 'invalid: there is a more recent event version' }
          }
        }
      }

      // 1. Check Limits & Prepare Ops
      const { ownerType, _ownerKey, popularityLevel, ops: storageOps } = await checkStorageLimitAndPrune({ pubkey: author, ip, newEventSize: byteSize })

      // Convert to MDB Record
      record ??= eventToRecord(event, { receivedAt: Math.floor(this.receivedAt / 1000) })

      // 2. Handle Replacement info (subtract old event size)
      let oldEvent = null

      try {
        oldEvent = await mdb.index('events').getDocument(record.ref)
      } catch (_e) {
        // Not found, new event
      }

      const ops = [...storageOps]

      if (oldEvent) {
        // Subtract old usage
        const oldOwnerType = oldEvent.ownerType || 'pubkey'
        const oldOwnerKey = oldOwnerType === 'pubkey' ? oldEvent.pubkey : ipToPrimaryKey(oldEvent.ip)
        if (oldOwnerKey) {
          ops.push({
            type: 'deltaUsage',
            data: { key: oldOwnerKey, delta: -(oldEvent.byteSize || 0), entityType: oldOwnerType }
          })
        }
      }

      // 3. Save New Event (Queue it)
      const dbEvent = {
        ...record,
        byteSize,
        ownerType,
        ip,
        popularityLevel,
        ...(oldEvent?.commentCounter && { commentCounter: oldEvent.commentCounter }),
        ...(oldEvent?.replyCounter && { replyCounter: oldEvent.replyCounter }),
        ...(oldEvent?.repostCounter && { repostCounter: oldEvent.repostCounter }),
        ...(oldEvent?.quoteCounter && { quoteCounter: oldEvent.quoteCounter })
        // receivedAt is already in record
      }

      // Add 'insertOrReplaceDocument' op
      ops.push({
        type: 'insertOrReplaceDocument',
        data: { index: 'events', document: dbEvent }
      })

      if (popularityLevel <= 6) {
        const pushHllOp = (rootEventId, field) => {
          if (!rootEventId) return
          try {
            const offset = parseInt(rootEventId[32], 16) + 8
            const hll = new HLL(offset)
            hll.add(base16ToBytes(author))
            ops.push({
              type: 'mergeNip45Hll',
              data: {
                key: idToRef(rootEventId),
                hll: bytesToBase16(hll.getRegisters()),
                field,
                index: 'events',
                offset
              }
            })
          } catch (e) {
            console.error(`Failed to process HLL for ${field}:`, e)
          }
        }

        if (event.kind === eventKinds.COMMENT) {
          const rootEventId = event.tags.find(t => t[0] === 'E')?.[1]
          pushHllOp(rootEventId, 'commentCounter')
        } else if (event.kind === eventKinds.TEXT_NOTE) {
          const rootEventId = event.tags.find(t => t[0] === 'e')?.[1]
          pushHllOp(rootEventId, 'replyCounter')
        } else if (event.kind === eventKinds.REPOST || event.kind === eventKinds.GENERIC_REPOST) {
          const rootEventId = event.tags.find(t => t[0] === 'e')?.[1]
          pushHllOp(rootEventId, 'repostCounter')
        }

        // Quote counter
        const quoteEventId = event.tags.find(t => t[0] === 'q')?.[1]
        if (quoteEventId && (event.kind === eventKinds.TEXT_NOTE || event.kind === eventKinds.COMMENT)) {
          pushHllOp(quoteEventId, 'quoteCounter')
        }
      }

      await queueOps(ops)

      return { isSuccess: true, isDuplicate: false, message: '' }
    } catch (err) {
      console.error(err)
      return { isSuccess: false, message: 'error: error saving' }
    }
  }

  async handleDelete ({ author }) {
    const { event } = this
    try {
      const idOrAddressTags = {
        [eventTags.EVENT]: true,
        [eventTags.ADDRESS]: true
      }
      const [ids, addresses] = event.tags
        .slice(0, 100)
        .filter(v => idOrAddressTags[v[0]])
        .reduce((r, v) => {
          if (v[0] === eventTags.EVENT) r[0].push(v[1])
          else if (v[0] === eventTags.ADDRESS) r[1].push(v[1])
          return r
        }, [[], []])

      if (
        ids.length === 0 &&
        addresses.length === 0
      ) {
        return { isSuccess: false, isDuplicate: false, message: 'invalid: no ids or addresses to delete' }
      }

      let addressesWithoutPubkeyFilter = ''
      if (addresses.length > 0) {
        const filters = []
        for (const address of addresses) {
          let [kind, pubkey, dTag] = address.split(':')
          if (pubkey !== author) return { isSuccess: false, isDuplicate: false, message: 'invalid: can only delete your own events' }
          if (
            isNaN((kind = parseInt(kind))) ||
            dTag === undefined
          ) continue
          if (kind === eventKinds.DELETION) return { isSuccess: false, isDuplicate: false, message: 'invalid: can\'t delete deletion events' }
          filters.push(`(kind = ${mdb.toMeiliValue(kind)} AND indexableTags = ${mdb.toMeiliValue(`d ${dTag}`)})`)
        }
        addressesWithoutPubkeyFilter = filters.join(' OR ')
      }

      const idsFilter = ids.length > 0 ? `id IN [${ids.map(id => mdb.toMeiliValue(id)).join(', ')}]` : ''
      if (idsFilter.length === 0 && addressesWithoutPubkeyFilter.length === 0) return { isSuccess: false, isDuplicate: false, message: 'invalid: no ids or addresses to delete' }
      const authorVal = mdb.toMeiliValue(author)
      const idsOrAddressesFilter = [
        idsFilter,
        addressesWithoutPubkeyFilter.length === 0
          ? null
          // created_at check is important to avoid deleting future replaceable/addressable events
          // pubkey must be set to not match other authors' events
          : `created_at <= ${mdb.toMeiliValue(event.created_at)} AND pubkey = ${authorVal} AND (${addressesWithoutPubkeyFilter})`
      ].filter(Boolean)
        .map(v => `(${v})`)
        .join(' OR ')

      // Check if any of the id/addresses are invalid (pubkey mismatch or kind 5)
      let filter = `(${
        idsOrAddressesFilter}) AND (NOT pubkey = ${
          authorVal} OR kind = ${eventKinds.DELETION})`
      const { estimatedTotalHits: isInvalid } = await mdb.index('events').search('', { filter, limit: 1, offset: mdb.constants.maxTotalHits })
      if (isInvalid) {
        return { isSuccess: false, isDuplicate: false, message: 'invalid: some events to delete do not belong to the author or are deletion events' }
      }

      // Find events to delete
      filter = `pubkey = ${authorVal} AND (${idsOrAddressesFilter})`
      const searchRes = await mdb.index('events').search('', { filter, limit: 100 })

      const ops = []
      for (const hit of searchRes.hits) {
        // Subtract size from owner
        const ownerType = hit.ownerType || 'pubkey'
        const ownerKey = ownerType === 'pubkey' ? hit.pubkey : ipToPrimaryKey(hit.ip)

        if (ownerKey) {
          ops.push({
            type: 'deltaUsage',
            data: { key: ownerKey, delta: -(hit.byteSize || 0), entityType: ownerType }
          })
        }
        ops.push({
          type: 'deleteDocumentIfExists',
          data: { index: 'events', key: hit.ref }
        })
      }

      if (ops.length > 0) {
        await queueOps(ops)
      }

      return { isSuccess: true }
    } catch (err) {
      console.error(err)
      return { isSuccess: false, isDuplicate: false, message: 'error: error deleting' }
    }
  }
}
