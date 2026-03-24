import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import { processBatch, loadSystemState } from '#models/job/jobs/process-pending-ops/index.js'
import * as deleteStaleChunksJob from '#models/job/jobs/delete-stale-chunks.js'

const runPendingOps = async () => {
  const { hits } = await mdb.index('pendingOps').search('', { limit: 1000, sort: ['createdAt:asc'] })
  if (hits.length === 0) return
  const state = await loadSystemState()
  await processBatch(hits, state)
}

// Seconds well beyond the 3-day grace period
const OLD_RECEIVED_AT = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 10

function makeChunkEvent ({ ref, pubkey, rootX, index = 0, byteSize = 51000, created_at = 100, receivedAt = OLD_RECEIVED_AT, extraCTags = [] }) {
  const ctagMainValue = `${rootX}:${index}`
  const indexableTags = [`c ${ctagMainValue}`, `d ${ref}`]
  for (const extra of extraCTags) {
    indexableTags.push(`c ${extra}`)
  }
  return {
    ref,
    id: ref,
    pubkey,
    kind: 34600,
    created_at,
    byteSize,
    ownerType: 'pubkey',
    receivedAt,
    indexableTags,
    nonIndexableTags: [],
    content: '',
    sig: 'sig'
  }
}

function makeManifestEvent ({ ref, pubkey, kind = 35128, fileRootHashes = [] }) {
  return {
    ref,
    id: ref,
    pubkey,
    kind,
    created_at: 100,
    ownerType: 'pubkey',
    indexableTags: [`d ${ref}`],
    nonIndexableTags: fileRootHashes.map(h => ['path', 'path.js', h]),
    content: '',
    sig: 'sig'
  }
}

describe('Job: Delete Stale Chunks', () => {
  beforeEach(async () => {
    await Promise.all([
      mdb.index('events').deleteAllDocuments(),
      mdb.index('pendingOps').deleteAllDocuments(),
      mdb.index('storedEventOwners').deleteAllDocuments()
    ])
  })

  it('config should have correct structure', () => {
    assert.equal(deleteStaleChunksJob.default.key, 'deleteStaleChunks')
    assert.equal(typeof deleteStaleChunksJob.default.run, 'function')
    assert.equal(deleteStaleChunksJob.default.shouldUseLock, true)
    assert.equal(deleteStaleChunksJob.default.frequency, 60 * 60 * 24)
  })

  it('should delete stale chunks not referenced by any manifest or r tag', async () => {
    const pubkey = '0000000000000000000000000000000000000000000000000000000000000001'

    // Stale chunk: rootX 'aaaa' not referenced anywhere
    const staleChunk = makeChunkEvent({ ref: 'stale1', pubkey, rootX: 'aaaa' })

    // Referenced chunk: rootX 'bbbb' is in a manifest's path tags
    const referencedChunk = makeChunkEvent({ ref: 'referenced1', pubkey, rootX: 'bbbb' })
    const manifest = makeManifestEvent({ ref: 'manifest1', pubkey, fileRootHashes: ['bbbb'] })

    await mdb.index('events').addDocuments([staleChunk, referencedChunk, manifest])
    await new Promise(resolve => setTimeout(resolve, 100))

    await deleteStaleChunksJob.run()
    await runPendingOps()
    await new Promise(resolve => setTimeout(resolve, 100))

    const { results } = await mdb.index('events').getDocuments({ limit: 100 })
    const events = results.filter(e => e.ref !== '__processingState__')

    assert.ok(!events.find(e => e.ref === 'stale1'), 'Stale chunk should be deleted')
    assert.ok(events.find(e => e.ref === 'referenced1'), 'Referenced chunk should be kept')
    assert.ok(events.find(e => e.ref === 'manifest1'), 'Manifest event should be kept')
  })

  it('should keep chunks referenced by r tags on same-author events', async () => {
    const pubkey = '0000000000000000000000000000000000000000000000000000000000000002'

    // Chunk with rootX 'cccc'
    const chunk = makeChunkEvent({ ref: 'rchunk1', pubkey, rootX: 'cccc' })

    // Same-author event referencing this file's root hash via r tag
    const referencingEvent = {
      ref: 'noter1',
      id: 'noter1',
      pubkey,
      kind: 1,
      created_at: 200,
      ownerType: 'pubkey',
      indexableTags: ['r cccc'],
      content: 'references the file root hash',
      sig: 'sig'
    }

    await mdb.index('events').addDocuments([chunk, referencingEvent])
    await new Promise(resolve => setTimeout(resolve, 100))

    await deleteStaleChunksJob.run()
    await runPendingOps()
    await new Promise(resolve => setTimeout(resolve, 100))

    const { results } = await mdb.index('events').getDocuments({ limit: 100 })
    const events = results.filter(e => e.ref !== '__processingState__')

    assert.ok(events.find(e => e.ref === 'rchunk1'), 'Chunk referenced by r tag should be kept')
  })

  it('should skip chunks uploaded within the grace period', async () => {
    const pubkey = '0000000000000000000000000000000000000000000000000000000000000003'
    const recentReceivedAt = Math.floor(Date.now() / 1000) - 60 * 60 // 1 hour ago

    // Recent chunk (within grace period) — unreferenced but should be kept
    const recentChunk = makeChunkEvent({
      ref: 'recent1',
      pubkey,
      rootX: 'dddd',
      receivedAt: recentReceivedAt
    })

    // Old chunk — unreferenced and should be deleted
    const oldChunk = makeChunkEvent({ ref: 'old1', pubkey, rootX: 'eeee' })

    await mdb.index('events').addDocuments([recentChunk, oldChunk])
    await new Promise(resolve => setTimeout(resolve, 100))

    await deleteStaleChunksJob.run()
    await runPendingOps()
    await new Promise(resolve => setTimeout(resolve, 100))

    const { results } = await mdb.index('events').getDocuments({ limit: 100 })
    const events = results.filter(e => e.ref !== '__processingState__')

    assert.ok(events.find(e => e.ref === 'recent1'), 'Recent chunk should be kept (grace period)')
    assert.ok(!events.find(e => e.ref === 'old1'), 'Old unreferenced chunk should be deleted')
  })

  it('should skip chunks owned by IP (non-popular users)', async () => {
    const pubkey = '0000000000000000000000000000000000000000000000000000000000000004'

    // Chunk owned by IP — should be skipped by the job
    const ipChunk = {
      ...makeChunkEvent({ ref: 'ipchunk1', pubkey, rootX: 'ffff' }),
      ownerType: 'ip',
      ip: '10.0.0.1'
    }

    await mdb.index('events').addDocuments([ipChunk])
    await new Promise(resolve => setTimeout(resolve, 100))

    await deleteStaleChunksJob.run()
    await runPendingOps()
    await new Promise(resolve => setTimeout(resolve, 100))

    const { results } = await mdb.index('events').getDocuments({ limit: 100 })
    const events = results.filter(e => e.ref !== '__processingState__')

    assert.ok(events.find(e => e.ref === 'ipchunk1'), 'IP-owned chunk should be skipped')
  })

  it('should decrement usedBytes for pubkey when deleting stale chunks', async () => {
    const pubkey = '0000000000000000000000000000000000000000000000000000000000000005'

    await mdb.index('storedEventOwners').addDocuments([{
      key: pubkey,
      entityType: 'pubkey',
      usedBytes: 100000,
      popularityLevel: 3
    }])

    const chunk = makeChunkEvent({ ref: 'usage1', pubkey, rootX: 'gggg', byteSize: 51000 })

    await mdb.index('events').addDocuments([chunk])
    await new Promise(resolve => setTimeout(resolve, 100))

    await deleteStaleChunksJob.run()
    await runPendingOps()
    await new Promise(resolve => setTimeout(resolve, 100))

    const owner = await mdb.index('storedEventOwners').getDocument(pubkey)
    assert.equal(owner.usedBytes, 49000, 'usedBytes should be decremented by chunk byteSize')
  })

  it('should handle chunks with multiple c tags (multiple files) correctly', async () => {
    const pubkey = '0000000000000000000000000000000000000000000000000000000000000007'

    // Chunk used in two files: rootX 'iiii' (referenced by same-author manifest) and 'jjjj' (not referenced)
    const sharedChunk = makeChunkEvent({
      ref: 'shared1',
      pubkey,
      rootX: 'iiii',
      extraCTags: ['jjjj:5']
    })

    const manifest = makeManifestEvent({ ref: 'manifest2', pubkey, fileRootHashes: ['iiii'] })

    await mdb.index('events').addDocuments([sharedChunk, manifest])
    await new Promise(resolve => setTimeout(resolve, 100))

    await deleteStaleChunksJob.run()
    await runPendingOps()
    await new Promise(resolve => setTimeout(resolve, 100))

    const { results } = await mdb.index('events').getDocuments({ limit: 100 })
    const events = results.filter(e => e.ref !== '__processingState__')

    assert.ok(events.find(e => e.ref === 'shared1'), 'Chunk with one referenced rootX should be kept')
  })

  it('should delete chunks when only a different pubkey references the same rootX', async () => {
    const pubkeyA = '0000000000000000000000000000000000000000000000000000000000000008'
    const pubkeyB = '0000000000000000000000000000000000000000000000000000000000000009'

    // Chunk from pubkey A with rootX 'kkkk'
    const chunk = makeChunkEvent({ ref: 'cross1', pubkey: pubkeyA, rootX: 'kkkk' })

    // Manifest from pubkey B referencing the same rootX — should NOT protect A's chunk
    const manifest = makeManifestEvent({ ref: 'manifestB', pubkey: pubkeyB, fileRootHashes: ['kkkk'] })

    // r-tag event from pubkey B referencing the same rootX — should NOT protect A's chunk
    const rTagEvent = {
      ref: 'rEventB',
      id: 'rEventB',
      pubkey: pubkeyB,
      kind: 1,
      created_at: 200,
      ownerType: 'pubkey',
      indexableTags: ['r kkkk'],
      content: '',
      sig: 'sig'
    }

    await mdb.index('events').addDocuments([chunk, manifest, rTagEvent])
    await new Promise(resolve => setTimeout(resolve, 100))

    await deleteStaleChunksJob.run()
    await runPendingOps()
    await new Promise(resolve => setTimeout(resolve, 100))

    const { results } = await mdb.index('events').getDocuments({ limit: 100 })
    const events = results.filter(e => e.ref !== '__processingState__')

    assert.ok(!events.find(e => e.ref === 'cross1'), 'Chunk should be deleted when only a different pubkey references it')
    assert.ok(events.find(e => e.ref === 'manifestB'), 'Other pubkey manifest should be kept')
    assert.ok(events.find(e => e.ref === 'rEventB'), 'Other pubkey r-tag event should be kept')
  })
})
