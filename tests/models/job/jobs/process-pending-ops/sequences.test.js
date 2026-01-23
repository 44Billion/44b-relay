import { describe, it, beforeEach, after, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'

describe('Job: Process Pending Ops - Sequences', () => {
  let processPendingOps
  let pruneEventsMock
  let runSingleBatch

  before(async () => {
    pruneEventsMock = mock.fn(async () => 0)

    mock.module('#services/event/maintainer/mdb/index.js', {
      namedExports: {
        pruneEvents: pruneEventsMock,
        checkStorageLimitAndPrune: async () => {},
        queueOps: async () => {}
      }
    })

    processPendingOps = await import('#models/job/jobs/process-pending-ops/index.js')

    runSingleBatch = async () => {
      const { hits } = await mdb.index('pendingOps').search('', { limit: 1000, sort: ['createdAt:asc'] })
      const state = await processPendingOps.loadSystemState()
      await processPendingOps.processBatch(hits, state)
    }
  })

  after(() => {
    mock.restoreAll()
  })

  beforeEach(async () => {
    pruneEventsMock.mock.resetCalls()
    const indexes = ['pendingOps', 'events', 'storedEventOwners']
    for (const idx of indexes) {
      await mdb.index(idx).deleteAllDocuments()
    }
  })

  it('1) insertOrReplaceDocument > deleteDocumentIfExists > patchDocumentIfExists (should not patch as document is deleted)', async () => {
    const docId = 'seq_1_doc'
    // Pre-seed document to ensure we test "delete existing" scenario which is trickier for caching
    await mdb.index('events').addDocuments([{ ref: docId, val: 'pre-existing' }])

    const doc = { ref: docId, val: 'inserted' }

    // We create ops sorted by createdAt to enforce order
    // Op 1: Insert
    const op1 = {
      key: 'op1',
      createdAt: 1000,
      type: 'insertOrReplaceDocument',
      data: { index: 'events', document: doc }
    }
    // Op 2: Delete
    const op2 = {
      key: 'op2',
      createdAt: 1001,
      type: 'deleteDocumentIfExists',
      data: { index: 'events', key: docId }
    }
    // Op 3: Patch
    const op3 = {
      key: 'op3',
      createdAt: 1002,
      type: 'patchDocumentIfExists',
      data: { index: 'events', document: { ref: docId, val: 'patched' } }
    }

    await mdb.index('pendingOps').addDocuments([op1, op2, op3])
    await runSingleBatch()

    // Expectation: Document should NOT exist
    try {
      await mdb.index('events').getDocument(docId)
      assert.fail(`Document should be deleted. Found: ${JSON.stringify(await mdb.index('events').getDocument(docId))}`)
    } catch (e) {
      const isNotFound = (e.code === 'document_not_found') || (e.cause?.code === 'document_not_found') || (e.response && e.response.status === 404)
      assert.ok(isNotFound, 'Should return document_not_found')
    }
  })

  it('2) insertOrReplaceDocument > deleteDocumentIfExists (should be deleted)', async () => {
    const docId = 'seq_2_doc'
    const doc = { ref: docId, val: 'initial' }

    const op1 = {
      key: 'op1',
      createdAt: 1000,
      type: 'insertOrReplaceDocument',
      data: { index: 'events', document: doc }
    }
    const op2 = {
      key: 'op2',
      createdAt: 1001,
      type: 'deleteDocumentIfExists',
      data: { index: 'events', key: docId }
    }

    await mdb.index('pendingOps').addDocuments([op1, op2])
    await runSingleBatch()

    try {
      await mdb.index('events').getDocument(docId)
      assert.fail('Document should be deleted')
    } catch (e) {
      const isNotFound = (e.code === 'document_not_found') || (e.cause?.code === 'document_not_found') || (e.response && e.response.status === 404)
      assert.ok(isNotFound, 'Should return document_not_found')
    }
  })

  it('3) insertOrReplaceDocument > deleteDocumentIfExists > insertOrReplaceDocument > patchDocumentIfExists (should apply the patch)', async () => {
    const docId = 'seq_3_doc'
    const docA = { ref: docId, val: 'A' }
    const docB = { ref: docId, val: 'B' }

    const op1 = {
      key: 'op1',
      createdAt: 1000,
      type: 'insertOrReplaceDocument',
      data: { index: 'events', document: docA }
    }
    const op2 = {
      key: 'op2',
      createdAt: 1001,
      type: 'deleteDocumentIfExists',
      data: { index: 'events', key: docId }
    }
    const op3 = {
      key: 'op3',
      createdAt: 1002,
      type: 'insertOrReplaceDocument',
      data: { index: 'events', document: docB }
    }
    const op4 = {
      key: 'op4',
      createdAt: 1003,
      type: 'patchDocumentIfExists',
      data: { index: 'events', document: { ref: docId, extra: 'patched' } }
    }

    await mdb.index('pendingOps').addDocuments([op1, op2, op3, op4])
    await runSingleBatch()

    const result = await mdb.index('events').getDocument(docId)
    assert.equal(result.val, 'B', 'Should have val B')
    assert.equal(result.extra, 'patched', 'Should be patched')
  })

  it('4) insertOrReplaceDocument > deleteDocumentIfExists > insertOrReplaceDocument > deleteDocumentIfExists (should be deleted)', async () => {
    const docId = 'seq_4_doc'
    const doc = { ref: docId, val: 'initial' }

    const op1 = {
      key: 'op1',
      createdAt: 1000,
      type: 'insertOrReplaceDocument',
      data: { index: 'events', document: doc }
    }
    const op2 = {
      key: 'op2',
      createdAt: 1001,
      type: 'deleteDocumentIfExists',
      data: { index: 'events', key: docId }
    }
    const op3 = {
      key: 'op3',
      createdAt: 1002,
      type: 'insertOrReplaceDocument',
      data: { index: 'events', document: doc }
    }
    const op4 = {
      key: 'op4',
      createdAt: 1003,
      type: 'deleteDocumentIfExists',
      data: { index: 'events', key: docId }
    }

    await mdb.index('pendingOps').addDocuments([op1, op2, op3, op4])
    await runSingleBatch()

    try {
      await mdb.index('events').getDocument(docId)
      assert.fail('Document should be deleted')
    } catch (e) {
      const isNotFound = (e.code === 'document_not_found') || (e.cause?.code === 'document_not_found') || (e.response && e.response.status === 404)
      assert.ok(isNotFound, 'Should return document_not_found')
    }
  })
})
