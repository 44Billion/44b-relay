import mdb from '#services/db/mdb.js'

export async function getJobByKey (key) {
  return mdb.index('jobs').getDocument(key)
    .then(record => ({ result: record, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

// Won't add record if it doesn't exist
export async function patchJobByKey (key, patch) {
  const record = await mdb.index('jobs').getDocument(key)
  if (!record) {
    return { result: null, error: new Error('Job not found'), success: false }
  }

  return mdb.index('jobs').updateDocuments([{
    key,
    ...patch
  }])
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

// Adds doc if it doesn't exist
export async function putJobByKey (key, patch) {
  // MeiliSearch updateDocuments (also addDocuments) acts as upsert
  return mdb.index('jobs').updateDocuments([{
    key,
    ...patch
  }])
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}
