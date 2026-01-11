import { getAuthorPubkey } from '#helpers/event.js'
import { eventKinds, eventTags } from '#constants/event.js'
import mdb from '#services/db/mdb.js'
import { checkStorageLimitAndPrune, queueOps } from '#services/event/maintainer/mdb/index.js'
import { eventToRecord } from '#models/event/mapper.js'

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

    // Handle Deletion Events
    if (event.kind === eventKinds.DELETION) {
      try {
        const ids = event.tags.filter(v => v[0] === eventTags.EVENT).slice(0, 100).map(v => v[1])
        if (ids.length === 0) return { isSuccess: true, isDuplicate: false, message: '' }

        // Find events to delete
        // MDB filter needs IN operator or ORs. "id IN [a,b,c]"
        const filter = `id IN [${ids.map(id => mdb.toMeiliValue(id)).join(', ')}] AND pubkey = ${mdb.toMeiliValue(author)}`
        const searchRes = await mdb.index('events').search('', { filter, limit: 100 })

        const ops = []
        for (const hit of searchRes.hits) {
          // Subtract size from owner
          const ownerType = hit.owner || 'pk'
          const ownerKey = ownerType === 'pk' ? hit.pubkey : hit.ip

          if (ownerKey) {
            ops.push({
              targetKey: ownerKey,
              type: 'delta_usage',
              data: { delta: -(hit.byteSize || 0), ownerType }
            })
          }
          ops.push({
            targetKey: ownerKey, // We use ownerKey to group execution in the worker
            type: 'delete_event',
            data: { id: hit.ref || hit.id, ownerType }
          })
        }

        if (ops.length > 0) {
          await queueOps(ops)
        }
        return { isSuccess: true, isDuplicate: false, message: '' }
      } catch (err) {
        console.error(err)
        return { isSuccess: false, message: 'error deleting' }
      }
    }

    // Handle Regular/Replaceable Events
    try {
      // 1. Check Limits & Prepare Ops
      const { ownerType, ownerKey, popularityLevel, ops: storageOps } = await checkStorageLimitAndPrune({ pubkey: author, ip, newEventSize: byteSize })

      // Convert to MDB Record
      const record = eventToRecord(event, { receivedAt: Math.floor(this.receivedAt / 1000) })

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
        const oldOwnerType = oldEvent.owner || 'pk'
        const oldOwnerKey = oldOwnerType === 'pk' ? oldEvent.pubkey : oldEvent.ip
        if (oldOwnerKey) {
          ops.push({
            targetKey: oldOwnerKey,
            type: 'delta_usage',
            data: { delta: -(oldEvent.byteSize || 0), ownerType: oldOwnerType }
          })
        }
        // Implicit replacement by 'save_event' later?
        // Actually save_event with same PK will replace.
        // But if the old event owner is DIFFERENT (e.g. key rotation or IP assignment change?),
        // `oldOwnerKey` might perform usage update.
        // We probably don't need explicit 'delete_event' for replacement unless we want to sure.
        // Let's rely on overwrite.
      }

      // 3. Save New Event (Queue it)
      const dbEvent = {
        ...record,
        byteSize,
        owner: ownerType,
        ip,
        popularityLevel
        // receivedAt is already in record
      }

      // Add 'save_event' op
      ops.push({
        targetKey: ownerKey,
        type: 'save_event',
        data: { event: dbEvent, ownerType }
      })

      await queueOps(ops)

      return { isSuccess: true, isDuplicate: false, message: '' }
    } catch (err) {
      console.error(err)
      return { isSuccess: false, message: 'error saving' }
    }
  }
}
