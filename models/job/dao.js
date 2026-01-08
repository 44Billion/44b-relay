import { db } from '#services/db/mdb.js'

export async function getJobByKey (key) {
  return db.index('jobs').getDocument(key)
    .then(record => ({ result: record, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

// Won't add record if it doesn't exist
export async function patchJobByKey (key, patch) {
  const record = await db.index('jobs').getDocument(key)
  if (!record) {
    return { result: null, error: new Error('Job not found'), success: false }
  }

  return db.index('jobs').updateDocuments([{
    key,
    ...patch
  }])
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

// Adds doc if it doesn't exist
export async function putJobByKey (key, patch) {
  // MeiliSearch updateDocuments acts as upsert
  return db.index('jobs').updateDocuments([{
    key,
    ...patch
  }])
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}
