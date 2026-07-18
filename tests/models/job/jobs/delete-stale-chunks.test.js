import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import NMMR from 'nmmr'
import { encode } from 'libp2r2p/base93'
import mdb from '#services/db/mdb.js'
import { ipToPrimaryKey } from '#helpers/mdb.js'
import { eventToRecord } from '#models/event/mapper.js'
import { processBatch, loadSystemState } from '#models/job/jobs/process-pending-ops/index.js'
import * as deleteStaleChunksJob from '#models/job/jobs/delete-stale-chunks.js'

const runPendingOps = async () => {
  const { hits } = await mdb.index('pendingOps').search('', { limit: 1000, sort: ['createdAt:asc'] })
  if (!hits.length) return
  await processBatch(hits, await loadSystemState())
}

const OLD_RECEIVED_AT = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 10
const root = hex => hex.repeat(64)

function makeChunkEvent ({
  ref, pubkey, contentKey = ref, byteSize = 51000,
  receivedAt = OLD_RECEIVED_AT, ownerType = 'pubkey', ip
}) {
  const contentBytes = new TextEncoder().encode(contentKey)
  const proof = new Uint8Array(0)
  const mmrRoot = NMMR.calculateRoot({ contentBytes, index: 0, total: 1, proof })
  const event = {
    id: '9'.repeat(64),
    pubkey,
    kind: 34601,
    created_at: 100,
    tags: [
      ['d', NMMR.deriveChunkId(mmrRoot, 0)],
      ['mmr', '0', '1', '']
    ],
    content: encode(contentBytes),
    sig: 'f'.repeat(128)
  }
  return {
    ...eventToRecord(event, {
      receivedAt,
      derivedMetadata: { mmrRoot, mmrIndex: 0, mmrTotal: 1 }
    }),
    ref,
    byteSize,
    ownerType,
    ...(ip && { ip })
  }
}

function makeReferencingEvent ({ ref, pubkey, roots }) {
  return {
    ref,
    id: ref,
    pubkey,
    kind: 35128,
    created_at: 100,
    byteSize: 100,
    ownerType: 'pubkey',
    receivedAt: OLD_RECEIVED_AT,
    blobRefs: roots,
    content: '',
    sig: 'sig'
  }
}

async function storedRefs () {
  const { results } = await mdb.index('events').getDocuments({ limit: 100 })
  return new Set(results.map(event => event.ref).filter(ref => ref !== '__processingState__'))
}

describe('Job: Delete Stale Chunks', () => {
  beforeEach(async () => {
    await Promise.all([
      mdb.index('events').deleteAllDocuments(),
      mdb.index('pendingOps').deleteAllDocuments(),
      mdb.index('storedEventOwners').deleteAllDocuments()
    ])
  })

  it('has the expected daily locked configuration', () => {
    assert.equal(deleteStaleChunksJob.default.key, 'deleteStaleChunks')
    assert.equal(typeof deleteStaleChunksJob.default.run, 'function')
    assert.equal(deleteStaleChunksJob.default.shouldUseLock, true)
    assert.equal(deleteStaleChunksJob.default.frequency, 60 * 60 * 24)
  })

  it('deletes old unreferenced chunks and keeps a same-author referenced root', async () => {
    const pubkey = root('1')
    const stale = makeChunkEvent({ ref: 'stale1', pubkey })
    const kept = makeChunkEvent({ ref: 'kept1', pubkey })
    await mdb.index('events').addDocuments([
      stale,
      kept,
      makeReferencingEvent({ ref: 'manifest1', pubkey, roots: [kept.mmrRoot] })
    ])

    await deleteStaleChunksJob.run()
    await runPendingOps()
    const refs = await storedRefs()
    assert.equal(refs.has('stale1'), false)
    assert.equal(refs.has('kept1'), true)
    assert.equal(refs.has('manifest1'), true)
  })

  it('loads blobRefs from any same-author event, including roots beyond indexed tags', async () => {
    const pubkey = root('2')
    const chunk = makeChunkEvent({ ref: 'chunk2', pubkey })
    await mdb.index('events').addDocuments([
      chunk,
      { ...makeReferencingEvent({ ref: 'note2', pubkey, roots: [chunk.mmrRoot] }), kind: 1 }
    ])

    await deleteStaleChunksJob.run()
    await runPendingOps()
    assert.equal((await storedRefs()).has('chunk2'), true)
  })

  it('keeps a recent unreferenced chunk during the three-day grace period', async () => {
    const pubkey = root('3')
    await mdb.index('events').addDocuments([
      makeChunkEvent({
        ref: 'recent3',
        pubkey,
        receivedAt: Math.floor(Date.now() / 1000) - 60 * 60
      }),
      makeChunkEvent({ ref: 'old3', pubkey })
    ])

    await deleteStaleChunksJob.run()
    await runPendingOps()
    const refs = await storedRefs()
    assert.equal(refs.has('recent3'), true)
    assert.equal(refs.has('old3'), false)
  })

  it('deletes missing or invalid derived metadata immediately, even during grace', async () => {
    const pubkey = root('4')
    const recent = Math.floor(Date.now() / 1000)
    const missing = makeChunkEvent({ ref: 'missing4', pubkey, receivedAt: recent })
    const range = makeChunkEvent({ ref: 'range4', pubkey, receivedAt: recent })
    const mutated = makeChunkEvent({ ref: 'mutated4', pubkey, receivedAt: recent })
    await mdb.index('events').addDocuments([
      { ...missing, mmrRoot: undefined },
      { ...range, mmrIndex: 2, mmrTotal: 2 },
      { ...mutated, nonFtsContent: `${mutated.nonFtsContent}x` }
    ])

    await deleteStaleChunksJob.run()
    await runPendingOps()
    const refs = await storedRefs()
    assert.equal(refs.has('missing4'), false)
    assert.equal(refs.has('range4'), false)
    assert.equal(refs.has('mutated4'), false)
  })

  it('does not let a different author protect a chunk with the same root', async () => {
    const pubkeyA = root('5')
    const pubkeyB = root('6')
    const chunk = makeChunkEvent({ ref: 'chunk5', pubkey: pubkeyA, contentKey: 'shared-content' })
    const sameRoot = makeChunkEvent({ ref: 'other5', pubkey: pubkeyB, contentKey: 'shared-content' }).mmrRoot
    assert.equal(chunk.mmrRoot, sameRoot)
    await mdb.index('events').addDocuments([
      chunk,
      makeReferencingEvent({ ref: 'manifest6', pubkey: pubkeyB, roots: [sameRoot] })
    ])

    await deleteStaleChunksJob.run()
    await runPendingOps()
    assert.equal((await storedRefs()).has('chunk5'), false)
  })

  it('updates ordinary pubkey usage after deleting chunks', async () => {
    const pubkey = root('7')
    await mdb.index('storedEventOwners').addDocuments([{
      key: pubkey,
      entityType: 'pubkey',
      usedBytes: 100000,
      popularityLevel: 3
    }])
    await mdb.index('events').addDocuments([
      makeChunkEvent({ ref: 'chunk7', pubkey, byteSize: 51000 })
    ])

    await deleteStaleChunksJob.run()
    await runPendingOps()
    assert.equal((await mdb.index('storedEventOwners').getDocument(pubkey)).usedBytes, 49000)
  })

  it('also collects and accounts for IP-owned chunks by their signed author', async () => {
    const pubkey = root('8')
    const ip = '10.0.0.8'
    const ownerKey = ipToPrimaryKey(ip)
    await mdb.index('storedEventOwners').addDocuments([{
      key: ownerKey,
      entityType: 'ip',
      usedBytes: 52000,
      popularityLevel: 999
    }])
    await mdb.index('events').addDocuments([
      makeChunkEvent({ ref: 'chunk8', pubkey, byteSize: 51000, ownerType: 'ip', ip })
    ])

    await deleteStaleChunksJob.run()
    await runPendingOps()
    assert.equal((await storedRefs()).has('chunk8'), false)
    assert.equal((await mdb.index('storedEventOwners').getDocument(ownerKey)).usedBytes, 1000)
  })
})
