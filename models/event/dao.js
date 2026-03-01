import mdb from '#services/db/mdb.js'
import { eventToRecord, recordToEvent } from './mapper.js'
import { queueOps } from '#services/event/maintainer/mdb/index.js'
import { ipToPrimaryKey } from '#helpers/mdb.js'

export async function getEventByRef (ref, options = {}) {
  return mdb.index('events').getDocument(ref, {
    ...(options.fields && { fields: options.fields })
  })
    .then(record => ({ result: recordToEvent(record, { withMeta: options.withMeta }), error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

// Good to update metadata such as lastAccessedAt
// Won't add record if it doesn't exist
export async function patchEventByRef (ref, patch) {
  return mdb.index('events').updateDocumentsByFunction({
    function: `
      let keys = context.keys();
      for key in keys {
        doc[key] = context[key];
      }
      doc
    `,
    filter: `ref = ${mdb.toMeiliValue(ref)}`,
    context: patch
  })
    .then(task => {
      if (task.details.matchedDocuments === 0 || task.details.editedDocuments === 0) {
        const error = new Error('Event not found')
        error.code = 'document_not_found'
        return { result: null, error, success: false }
      }
      return { result: null, error: null, success: true }
    })
    .catch(error => ({ result: null, error, success: false }))
}

// Adds doc if it doesn't exist, i.e., may create a record
// missing fields for not being present on the patch arg
export async function putEventByRef (ref, data) {
  return mdb.index('events').addDocuments([{
    ref,
    ...data
  }])
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

export async function getEvents (filter, { fields, withMeta = false } = {}) {
  return searchByNostrFilter(filter, { fields })
    .then(v => ({ result: v.hits.map(v2 => recordToEvent(v2, { withMeta })), error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

export async function countEvents (filter) {
  return searchByNostrFilter(filter, { metadataOnly: true })
    .then(v => ({ result: v.estimatedTotalHits, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

async function searchByNostrFilter ({
  ids, authors, kinds, tags, since, until, limit,
  search = '', // nip50
  popularityLevel, // not part of nostr spec
  spamOnly, // not part of nostr spec
  language, // nip50 extension
  sortTop // nip50 extension
}, { metadataOnly = false, fields } = {}) {
  limit = Math.min(limit || 20, 100)
  let q = search

  if (q) {
    // remove known unsupported search extensions
    q = q
      .replace(/followers:(>=|<=|>|<)?\d+/g, '')
      .replace(/sort:(hot|new|old)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  const sort = sortTop ? ['engagementCount:desc', 'created_at:desc', 'id:asc'] : ['created_at:desc', 'id:asc']

  return mdb.index('events').search(q, {
    ...(fields && { attributesToRetrieve: fields }),
    limit,
    filter: [
      // inner array is OR clause
      ...(ids ? [ids.map(id => `id = ${mdb.toMeiliValue(id)}`)] : []),
      ...(authors ? [authors.map(pubkey => `pubkey = ${mdb.toMeiliValue(pubkey)}`)] : []),
      ...(kinds ? [kinds.map(kind => `kind = ${mdb.toMeiliValue(kind)}`)] : []),
      ...(tags ? Object.entries(tags).map(([k, vs]) => vs.map(v => `indexableTags = ${mdb.toMeiliValue(`${k} ${v}`)}`)) : []),
      ...(since ? [`created_at >= ${mdb.toMeiliValue(since)}`] : []),
      ...(until ? [`created_at <= ${mdb.toMeiliValue(until)}`] : []),
      ...(language?.length ? [language.map(lang => `language = ${mdb.toMeiliValue(lang)}`)] : []),
      ...(popularityLevel ? [`popularityLevel <= ${mdb.toMeiliValue(popularityLevel)}`] : []),
      ...(spamOnly ? ['popularityLevel > 6'] : [])
    ],
    sort,
    offset: metadataOnly
      ? mdb.constants.maxTotalHits // hack to get no v.hits
      : 0
  })
}

export async function upsertEvent (event, options = {}) {
  validateEvent(event)
  const record = eventToRecord(event, options)
  if (record.expiresAt != null && record.expiresAt <= Math.floor(Date.now() / 1000)) return { result: record, success: true, isPersisted: false }
  return mdb.index('events').addDocuments([record])
    .then(() => ({ result: record, error: null, success: true, isPersisted: true }))
    .catch(error => ({ result: null, error, success: false, isPersisted: false }))
}

function validateEvent (_event) {
  return true
}

export async function deleteEventsById (ids) {
  return mdb.index('events').deleteDocuments({
    filter: [
      ids.map(id => `id = ${mdb.toMeiliValue(id)}`)
    ]
  })
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

export async function deleteEventsByRef (refs) {
  // ref field is the primary key of the events index
  return mdb.index('events').deleteDocuments(refs)
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

export async function deleteExpiredEvents () {
  const now = Math.floor(Date.now() / 1000)
  const filter = `expiresAt <= ${mdb.toMeiliValue(now)}`
  const BATCH_SIZE = 100

  try {
    let offset = 0
    while (true) {
      const { hits } = await mdb.index('events').search('', {
        filter,
        limit: BATCH_SIZE,
        offset,
        attributesToRetrieve: ['ref', 'byteSize', 'ownerType', 'pubkey', 'ip']
      })

      if (hits.length === 0) break

      // Group by owner to batch deltaUsage ops
      const usageByOwner = {}
      const ops = []

      for (const hit of hits) {
        // Schedule event deletion as a queued operation (atomic with usage update)
        ops.push({
          type: 'deleteDocumentIfExists',
          data: { index: 'events', key: hit.ref }
        })

        const ownerType = hit.ownerType || 'pubkey'
        const ownerKey = ownerType === 'pubkey' ? hit.pubkey : ipToPrimaryKey(hit.ip)
        if (!ownerKey) continue
        if (!usageByOwner[ownerKey]) usageByOwner[ownerKey] = { entityType: ownerType, delta: 0 }
        usageByOwner[ownerKey].delta -= (hit.byteSize || 0)
      }

      // Queue deltaUsage ops to decrement usedBytes
      for (const [key, { entityType, delta }] of Object.entries(usageByOwner)) {
        if (delta === 0) continue
        ops.push({
          type: 'deltaUsage',
          data: { key, delta, entityType }
        })
      }

      if (ops.length > 0) await queueOps(ops)

      // If we got fewer than BATCH_SIZE, we've exhausted the results
      if (hits.length < BATCH_SIZE) break
      // Increment offset since we're not deleting directly anymore;
      // deletes will happen when processPendingOps runs.
      offset += hits.length
    }

    return { result: null, error: null, success: true }
  } catch (error) {
    console.error('Error in deleteExpiredEvents:', error)
    return { result: null, error, success: false }
  }
}
