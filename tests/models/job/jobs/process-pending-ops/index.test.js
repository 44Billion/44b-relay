import { describe, it, beforeEach, after, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import { ipToPrimaryKey } from '#helpers/mdb.js'
import { HyperLogLog as HLL } from 'nostr-hll/hyperloglog.js'
import { compressAsync } from '#helpers/buffer.js'
import { bytesToBase64 } from '#helpers/base64.js'
import { sha256 } from '@noble/hashes/sha2.js'

describe('Job: Process Pending Ops', () => {
  let processPendingOps
  let pruneEventsMock
  let runSingleBatch

  before(async () => {
    // Mock pruneEvents to avoid complex interactions for now, unless we want full integration
    pruneEventsMock = mock.fn(async () => 0)

    mock.module('#services/event/maintainer/mdb/index.js', {
      namedExports: {
        pruneEvents: pruneEventsMock,
        // other exports if needed
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
    // Clear relevant indexes
    const indexes = ['pendingOps', 'storedEventOwners', 'events', 'ipActivities', 'requestedPubkeys']
    for (const idx of indexes) {
      await mdb.index(idx).deleteAllDocuments()
    }
  })

  describe('loadSystemState', () => {
    it('should load empty state when no state docs exist', async () => {
      const state = await processPendingOps.loadSystemState()
      assert.deepEqual(state.events, new Set())
      assert.deepEqual(state.storedEventOwners, new Set())
    })

    it('should load existing state from state docs', async () => {
      // Seed state doc in 'events' index
      const stateDoc = {
        ref: '__processingState__',
        processedOpIds: ['op1', 'op2']
      }
      await mdb.index('events').addDocuments([stateDoc])

      // Seed state doc in 'storedEventOwners' index
      const stateDoc2 = {
        key: '__processingState__',
        processedOpIds: ['op3']
      }
      await mdb.index('storedEventOwners').addDocuments([stateDoc2])

      const state = await processPendingOps.loadSystemState()

      assert.ok(state.events.has('op1'))
      assert.ok(state.events.has('op2'))
      assert.ok(state.storedEventOwners.has('op3'))
      assert.equal(state.ipActivities.size, 0)
    })
  })

  describe('run', () => {
    it('should process insertOrReplaceDocument op', async () => {
      const docToInsert = { id: 'doc1', content: 'foo', ref: 'doc1' }
      const op = {
        // Using fixed key for deterministic testing
        key: 'op_insert_1',
        createdAt: Date.now(),
        type: 'insertOrReplaceDocument',
        data: {
          index: 'events',
          document: docToInsert
        }
      }

      await mdb.index('pendingOps').addDocuments([op])

      await runSingleBatch()

      // 1. Verify Doc exists in events
      const doc = await mdb.index('events').getDocument('doc1')
      assert.equal(doc.content, 'foo')

      // 2. Verify Op removed from pendingOps
      try {
        await mdb.index('pendingOps').getDocument('op_insert_1')
        assert.fail('Op should be deleted')
      } catch (e) {
        const code = e.code || (e.cause && e.cause.code) || (e.response && e.response.status === 404 ? 'document_not_found' : undefined)
        assert.equal(code, 'document_not_found')
      }

      // 3. Verify processed state updated
      const stateDoc = await mdb.index('events').getDocument('__processingState__')
      assert.ok(stateDoc.processedOpIds.includes('op_insert_1'))
    })

    it('should process deltaUsage op', async () => {
      const ownerKey = 'pub1'
      const op = {
        key: 'op_usage_1',
        createdAt: Date.now(),
        type: 'deltaUsage',
        data: {
          targetKey: ownerKey,
          entityType: 'pubkey',
          delta: 100
        }
      }

      await mdb.index('pendingOps').addDocuments([op])
      await runSingleBatch()

      const doc = await mdb.index('storedEventOwners').getDocument(ownerKey)
      assert.equal(doc.usedBytes, 100)
      assert.equal(doc.entityType, 'pubkey')
    })

    it('should process deltaUsage op for IP (encoded key)', async () => {
      const ip = '127.0.0.1'
      const ownerKey = ipToPrimaryKey(ip)
      const op = {
        key: 'op_usage_ip',
        createdAt: Date.now(),
        type: 'deltaUsage',
        data: {
          targetKey: ownerKey, // Raw IP in ops
          entityType: 'ip',
          delta: 50
        }
      }

      await mdb.index('pendingOps').addDocuments([op])
      await runSingleBatch()

      const doc = await mdb.index('storedEventOwners').getDocument(ownerKey)
      assert.equal(doc.usedBytes, 50)
      assert.equal(doc.entityType, 'ip')
      assert.equal(doc.key, ownerKey)
    })

    it('should handle idempotency (skip processed ops)', async () => {
      const docToInsert = { id: 'doc_idem', content: 'original', ref: 'doc_idem' }

      // 1. Set state claiming op is processed
      await mdb.index('events').addDocuments([{
        ref: '__processingState__',
        processedOpIds: ['op_skip_me']
      }])

      // 2. Add the op that should be skipped
      const op = {
        key: 'op_skip_me', // Matches state
        createdAt: Date.now(),
        type: 'insertOrReplaceDocument',
        data: {
          index: 'events',
          document: docToInsert
        }
      }
      await mdb.index('pendingOps').addDocuments([op])

      // 3. Run
      await runSingleBatch()

      // 4. Verify Op removed (logic deletes processed ops)
      try {
        await mdb.index('pendingOps').getDocument('op_skip_me')
        assert.fail('Op should be deleted even if skipped')
      } catch (e) {
        const code = e.code || (e.cause && e.cause.code) || (e.response && e.response.status === 404 ? 'document_not_found' : undefined)
        assert.equal(code, 'document_not_found')
      }

      // 5. Verify Action NOT performed (Doc should not exist)
      try {
        await mdb.index('events').getDocument('doc_idem')
        assert.fail('Document should not be created')
      } catch (e) {
        const code = e.code || (e.cause && e.cause.code) || (e.response && e.response.status === 404 ? 'document_not_found' : undefined)
        assert.equal(code, 'document_not_found')
      }
    })

    it('should process mergeHll op and update count with delta', async () => {
      const utf8Encoder = new TextEncoder()
      const pubkey = 'pk_hll_1'
      const hll1 = new HLL(12)
      hll1.add(sha256(utf8Encoder.encode('ip1')))
      const hllBase64 = bytesToBase64(await compressAsync(hll1.getRegisters()))

      const op = {
        key: 'op_hll_1',
        createdAt: Date.now(),
        type: 'mergeHll',
        data: {
          targetKey: pubkey,
          hll: hllBase64
        }
      }

      await mdb.index('pendingOps').addDocuments([op])
      await runSingleBatch()

      // Verify doc created in requestedPubkeys
      const doc = await mdb.index('requestedPubkeys').getDocument(pubkey)
      assert.equal(doc.count, 1) // 1 IP added
      assert.ok(doc.firstSeenAt > 0)

      // Add another op with NEW IP
      const hll2 = new HLL(12)
      hll2.add(sha256(utf8Encoder.encode('ip2')))
      const otherHllBase64 = bytesToBase64(await compressAsync(hll2.getRegisters()))
      const op2 = {
        key: 'op_hll_2',
        createdAt: Date.now(),
        type: 'mergeHll',
        data: {
          targetKey: pubkey,
          hll: otherHllBase64
        }
      }
      await mdb.index('pendingOps').addDocuments([op2])
      await runSingleBatch()

      const doc2 = await mdb.index('requestedPubkeys').getDocument(pubkey)
      assert.equal(doc2.count, 2) // 1 + 1 (delta) = 2

      // Add another op with SAME IP (idempotency check for count)
      // Note: In real world, trackRequestedPubkeys protects against this in short term via cache,
      // but here we check if merge logic handles overlaps by correctly calculating delta.
      // HLL merge of same content results in same count, so delta should be 0.
      const hll3 = new HLL(12)
      hll3.add(sha256(utf8Encoder.encode('ip1')))
      const anotherHllBase64 = bytesToBase64(await compressAsync(hll3.getRegisters()))
      const op3 = {
        key: 'op_hll_3',
        createdAt: Date.now(),
        type: 'mergeHll',
        data: {
          targetKey: pubkey,
          hll: anotherHllBase64
        }
      }
      await mdb.index('pendingOps').addDocuments([op3])
      await runSingleBatch()

      const doc3 = await mdb.index('requestedPubkeys').getDocument(pubkey)
      assert.equal(doc3.count, 2) // 2 + 0 = 2
    })

    it('should process pruneCheck and trigger pruning if limit exceeded', async () => {
      const ownerKey = 'pub_prune'
      const op = {
        key: 'op_prune_1',
        createdAt: Date.now(),
        type: 'pruneCheck',
        data: {
          targetKey: ownerKey,
          entityType: 'pubkey',
          limit: 1000
        }
      }

      // Seed owner with high usage
      await mdb.index('storedEventOwners').addDocuments([{
        key: ownerKey,
        entityType: 'pubkey',
        usedBytes: 1500,
        popularityLevel: 1
      }])

      // Setup mock to simulate removing 500 bytes
      pruneEventsMock.mock.mockImplementation(async ({ bytesToRemove }) => {
        return bytesToRemove // simulate we removed exactly what was asked
      })

      await mdb.index('pendingOps').addDocuments([op])
      await runSingleBatch()

      // Verify pruneEvents called
      assert.equal(pruneEventsMock.mock.calls.length, 1)
      const callArgs = pruneEventsMock.mock.calls[0].arguments[0]
      assert.equal(callArgs.ownerKey, ownerKey)
      assert.equal(callArgs.bytesToRemove, 500) // 1500 - 1000

      // Verify storedEventOwner usage updated
      const doc = await mdb.index('storedEventOwners').getDocument(ownerKey)
      assert.equal(doc.usedBytes, 1000) // 1500 - 500
    })
  })
})
