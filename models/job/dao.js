import mdb from '#services/db/mdb.js'
import { getRandomId } from '#helpers/misc.js'

export async function getJobByKey (key) {
  return mdb.index('jobs').getDocument(key)
    .then(record => ({ result: record, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

// Won't add record if it doesn't exist
export async function patchJobByKey (key, patch) {
  const revision = getRandomId()
  return mdb.index('jobs').updateDocumentsByFunction({
    function: `
      let keys = context.keys();
      for key in keys {
        if key == "revision" {
          continue;
        }
        doc[key] = context[key];
      }
      doc.revision = context.revision;
      doc
    `,
    filter: `key = ${mdb.toMeiliValue(key)}`,
    context: { ...patch, revision }
  })
    .then(task => {
      if (task.details.matchedDocuments === 0 || task.details.editedDocuments === 0) {
        const error = new Error('Job not found')
        error.code = 'document_not_found'
        return { result: null, error, success: false }
      }
      return { result: null, error: null, success: true }
    })
    .catch(error => ({ result: null, error, success: false }))
}

export async function patchJobByRevision (key, expectedRevision, patch) {
  const revision = getRandomId()
  return mdb.index('jobs').updateDocumentsByFunction({
    function: `
      if doc.revision == context.expectedRevision {
        let keys = context.patch.keys();
        for key in keys {
          doc[key] = context.patch[key];
        }
        doc.revision = context.revision;
      }
      doc
    `,
    filter: `key = ${mdb.toMeiliValue(key)}`,
    context: {
      expectedRevision,
      patch,
      revision
    }
  })
    .then(async () => {
      // documentEdition detail fields vary across Meilisearch releases. The
      // revision written by the conditional function is the authoritative CAS
      // result and is also immune to task autobatching.
      const { result: record, error } = await getJobByKey(key)
      const success = record?.revision === revision
      return {
        result: success ? { revision, record } : null,
        error,
        success
      }
    })
    .catch(error => ({ result: null, error, success: false }))
}

export async function patchJobIfOwned (key, lockKey, patch) {
  const revision = getRandomId()
  return mdb.index('jobs').updateDocumentsByFunction({
    function: `
      if doc.lockKey == context.lockKey {
        let keys = context.patch.keys();
        for key in keys {
          doc[key] = context.patch[key];
        }
        doc.revision = context.revision;
      }
      doc
    `,
    filter: `key = ${mdb.toMeiliValue(key)}`,
    context: {
      lockKey,
      patch,
      revision
    }
  })
    .then(async () => {
      const { result: record, error } = await getJobByKey(key)
      const success = record?.revision === revision
      return {
        result: success ? { revision, record } : null,
        error,
        success
      }
    })
    .catch(error => ({ result: null, error, success: false }))
}

// Adds doc if it doesn't exist
export async function putJobByKey (key, data) {
  // MeiliSearch addDocuments (also updateDocuments) acts as upsert
  return mdb.index('jobs').addDocuments([{
    key,
    ...data,
    revision: getRandomId()
  }])
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}
