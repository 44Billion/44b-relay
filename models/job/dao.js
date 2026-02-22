import mdb from '#services/db/mdb.js'

export async function getJobByKey (key) {
  return mdb.index('jobs').getDocument(key)
    .then(record => ({ result: record, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

// Won't add record if it doesn't exist
export async function patchJobByKey (key, patch) {
  return mdb.index('jobs').updateDocumentsByFunction({
    function: `
      let keys = context.keys();
      for key in keys {
        doc[key] = context[key];
      }
      doc
    `,
    filter: `key = ${mdb.toMeiliValue(key)}`,
    context: patch
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

// Adds doc if it doesn't exist
export async function putJobByKey (key, data) {
  // MeiliSearch addDocuments (also updateDocuments) acts as upsert
  return mdb.index('jobs').addDocuments([{
    key,
    ...data
  }])
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}
