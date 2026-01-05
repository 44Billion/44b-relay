/* eslint-disable camelcase */
import { db } from '#services/db/mdb.js'
import { maxDateNowSeconds } from '#config/mdb.js'
import { bytesToBase64 } from '#helpers/base64.js'
import { base16ToBytes } from '#helpers/base16.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { eventToRecord, recordToEvent } from './mapper.js'

export async function getEventByRef (ref, options = {}) {
  return db.index('events').getDocument(ref, {
    ...(options.fields && { fields: options.fields })
  })
    .then(record => ({ result: recordToEvent(record), error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

// Good to update metadata such as lastAccessedAt
// Won't add record if it doesn't exist
export async function patchEventByRef (ref, patch) {
  const record = await db.index('events').getDocument(ref)
  if (!record) {
    return { result: null, error: new Error('Event not found'), success: false }
  }

  return record.update(patch)
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

// Adds doc if it doesn't exist, i.e., may create a record
// missing fields for not being present on the patch arg
export async function putEventByRef(ref, patch) {
  return db.index('events').updateDocuments([{
    ref,
    ...patch
  }])
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

export async function getEvents (filter, { fields } = {}) {
  if (fields === undefined) {
    fields = [
      'id',
      'pubkey',
      'kind',
      'nonIndexableTags',
      'indexableTags',
      'indexableTagExtras',
      'nonFtsContent',
      'ftsContent',
      'created_at',
      'sig'
    ]
  }
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
  search = '' // nip50
}, { metadataOnly = false, fields } = { }) {
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

  return db.index('events').search(q, {
    ...(fields && { fields }),
    limit,
    filter: [
      // inner array is OR clause
      ...(ids ? [ids.map(id => `id = ${db.toMeiliValue(id)}`)] : []),
      ...(authors ? [authors.map(pubkey => `pubkey = ${db.toMeiliValue(pubkey)}`)] : []),
      ...(kinds ? [kinds.map(kind => `kind = ${db.toMeiliValue(kind)}`)] : []),
      ...(tags ? Object.entries(tags).map(([k, vs]) => vs.map(v => `indexableTags = ${db.toMeiliValue(`${k} ${v}`)}`)) : []),
      ...(since ? [`created_at >= ${db.toMeiliValue(since)}`] : []),
      ...(until ? [`created_at <= ${db.toMeiliValue(until)}`] : []),
      ...(language ? [`language = ${db.toMeiliValue(language)}`] : [])
    ],
    sort: ['created_at:desc'],
    offset: metadataOnly
      ? db.constants.maxTotalHits // hack to get no v.hits
      : 0
  })
}

export async function upsertEvent (event, options = {}) {
  validateEvent(event)
  const record = eventToRecord(event, options)
  if (record.expiresAt != null && record.expiresAt <= Math.floor(Date.now() / 1000)) return { result: record, success: true, isPersisted: false }
  return db.index('events').addDocuments([record])
    .then(() => ({ result: record, error: null, success: true, isPersisted: true }))
    .catch(error => ({ result: null, error, success: false, isPersisted: false }))
}

function validateEvent (_event) {
  throw new Error('Not implemented yet')
}

export async function deleteEventsById (ids) {
  return db.index('events').deleteDocuments({
    filter: [
      ids.map(id => `id = ${db.toMeiliValue(id)}`)
    ]
  })
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

export async function deleteEventsByRef (refs) {
  // ref field is the primary key of the events index
  return db.index('events').deleteDocuments(refs)
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

export async function deleteExpiredEvents () {
  const now = Math.floor(Date.now() / 1000)
  return db.index('events').deleteDocuments({
    filter: [
      `expiresAt <= ${db.toMeiliValue(now)}`
    ]
  })
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}
