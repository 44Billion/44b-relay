import mdb from '#services/db/mdb.js'
import { eventToRecord, recordToEvent } from './mapper.js'

export async function getEventByRef (ref, options = {}) {
  return mdb.index('events').getDocument(ref, {
    ...(options.fields && { fields: options.fields })
  })
    .then(record => ({ result: recordToEvent(record), error: null, success: true }))
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
        return { result: null, error: new Error('Event not found'), success: false }
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

export async function getEvents (filter, { fields } = {}) {
  return searchByNostrFilter(filter, { fields })
    .then(v => ({ result: v.hits.map(recordToEvent), error: null, success: true }))
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
  popularityLevel // not part of nostr spec
}, { metadataOnly = false, fields } = {}) {
  limit = Math.min(limit || 20, 100)
  let language
  let q = search

  if (q) {
    const match = q.match(/language:([a-zA-Z]{2})/)
    if (match) language = match[1].toLowerCase()
    q = q
      .replace(/language:[a-zA-Z]{2}/g, '')
      .replace(/followers:(>=|<=|>|<)?\d+/g, '')
      .replace(/sort:(hot|top|new|old)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

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
      ...(language ? [`language = ${mdb.toMeiliValue(language)}`] : []),
      ...(popularityLevel ? [`popularityLevel <= ${mdb.toMeiliValue(popularityLevel)}`] : [])
    ],
    sort: ['created_at:desc', 'id:asc'],
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
  return mdb.index('events').deleteDocuments({
    filter: [
      `expiresAt <= ${mdb.toMeiliValue(now)}`
    ]
  })
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}
