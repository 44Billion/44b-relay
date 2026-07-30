import { beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import {
  loadSystemState,
  processBatch
} from '#models/job/jobs/process-pending-ops/index.js'
import {
  loadPopularityFilters,
  queueOps
} from '#services/event/maintainer/mdb/index.js'
import {
  getPruneCheckCoalescingKey,
  PRUNE_WORKFLOW_VERSION,
  queuePruneCheckOnce
} from '#services/event/prune-workflow.js'
import { getPruneTargetBytes } from '#services/event/prune-policy.js'
import { FastBloomFilter, packFilter } from '#helpers/bloom.js'
import { base16ToBytes } from 'libp2r2p/base16'
import { ipToPrimaryKey } from '#helpers/mdb.js'

const pubkey = '1'.repeat(64)

async function pendingOps () {
  return (await mdb.index('pendingOps').search('', {
    limit: 1000,
    sort: ['createdAt:asc', 'batchId:asc', 'position:asc', 'key:asc']
  })).hits
}

async function processAllPending () {
  for (let attempt = 0; attempt < 50; attempt++) {
    const hits = await pendingOps()
    if (!hits.length) return
    await processBatch(hits, await loadSystemState())
  }
  assert.fail('pending workflows did not finish')
}

function pruneOp ({
  key = 'prune-op',
  ownerKey = pubkey,
  ownerType = 'pubkey',
  limit = 0,
  data = {}
} = {}) {
  return {
    key,
    type: 'pruneCheck',
    phase: 'queued',
    createdAt: 1,
    batchId: 'prune-batch',
    position: 0,
    data: {
      key: ownerKey,
      entityType: ownerType,
      limit,
      targetBytes: getPruneTargetBytes(limit),
      workflowVersion: PRUNE_WORKFLOW_VERSION,
      step: 0,
      ...data
    }
  }
}

async function seedOwner ({
  key = pubkey,
  entityType = 'pubkey',
  usedBytes,
  popularityLevel = 999,
  lastActiveAt
}) {
  await mdb.index('storedEventOwners').addDocuments([{
    key,
    entityType,
    usedBytes,
    popularityLevel,
    accountingTokens: [],
    ...(lastActiveAt === undefined ? {} : { lastActiveAt })
  }])
}

async function markPopular (author, level = 1) {
  const filter = await FastBloomFilter.createOptimal(10, 0.001)
  filter.add(base16ToBytes(author))
  await mdb.index('popularPubkeys').addDocuments([{
    key: String(level),
    filter: await packFilter(filter)
  }])
  await loadPopularityFilters({ force: true })
}

async function markPopularMany (authors, level = 1) {
  const filter = await FastBloomFilter.createOptimal(authors.length * 2, 0.001)
  for (const author of authors) filter.add(base16ToBytes(author))
  await mdb.index('popularPubkeys').addDocuments([{
    key: String(level),
    filter: await packFilter(filter)
  }])
  await loadPopularityFilters({ force: true })
}

describe('durable owner pruning', () => {
  beforeEach(async () => {
    await Promise.all([
      mdb.index('events').deleteAllDocuments(),
      mdb.index('pendingOps').deleteAllDocuments(),
      mdb.index('storedEventOwners').deleteAllDocuments(),
      mdb.index('popularPubkeys').deleteAllDocuments()
    ])
  })

  it('persists deletion intent and finishes owner accounting', async () => {
    await seedOwner({ usedBytes: 500 })
    await mdb.index('events').addDocuments([{
      ref: 'ordinary',
      id: 'ordinary-id',
      pubkey,
      ownerType: 'pubkey',
      kind: 1,
      byteSize: 200,
      created_at: 1
    }])
    await mdb.index('pendingOps').addDocuments([
      pruneOp({ limit: 300 })
    ])

    await processAllPending()

    await assert.rejects(mdb.index('events').getDocument('ordinary'))
    const owner = await mdb.index('storedEventOwners').getDocument(pubkey)
    assert.equal(owner.usedBytes, 0)
    assert.deepEqual(owner.accountingTokens, [])
  })

  it('does not start destructive pruning from a preventive 90% marker', async () => {
    await seedOwner({ usedBytes: 950 })
    await mdb.index('events').addDocuments([{
      ref: 'preventive-marker',
      id: 'preventive-marker-id',
      pubkey,
      ownerType: 'pubkey',
      kind: 1,
      byteSize: 950,
      created_at: 1
    }])
    await mdb.index('pendingOps').addDocuments([
      pruneOp({ key: 'preventive-prune', limit: 1000 })
    ])

    await processAllPending()

    assert.equal(
      (await mdb.index('events').getDocument('preventive-marker')).id,
      'preventive-marker-id'
    )
    assert.equal(
      (await mdb.index('storedEventOwners').getDocument(pubkey)).usedBytes,
      950
    )
  })

  it('uses the 90% target for a v1 check without targetBytes', async () => {
    const events = Array.from({ length: 101 }, (_, index) => ({
      ref: `v1-target-${index}`,
      id: `v1-target-id-${index}`,
      pubkey,
      ownerType: 'pubkey',
      kind: 1,
      byteSize: 1,
      created_at: index
    }))
    await seedOwner({ usedBytes: events.length })
    await mdb.index('events').addDocuments(events)
    const legacyV1 = pruneOp({ key: 'v1-target-prune', limit: 100 })
    legacyV1.data.workflowVersion = 1
    delete legacyV1.data.targetBytes
    await mdb.index('pendingOps').addDocuments([legacyV1])

    await processAllPending()

    await assert.rejects(mdb.index('events').getDocument('v1-target-0'))
    assert.equal(
      (await mdb.index('events').getDocument('v1-target-100')).id,
      'v1-target-id-100'
    )
    assert.equal(
      (await mdb.index('storedEventOwners').getDocument(pubkey)).usedBytes,
      1
    )
  })

  it('deletes binary chunks before older ordinary events', async () => {
    const chunkBytes = 51_000
    await seedOwner({ usedBytes: chunkBytes * 2 + 100 })
    await mdb.index('events').addDocuments([
      {
        ref: 'old-text',
        id: 'old-text-id',
        pubkey,
        ownerType: 'pubkey',
        kind: 1,
        byteSize: 100,
        created_at: 1
      },
      {
        ref: 'chunk-1',
        id: 'chunk-1-id',
        pubkey,
        ownerType: 'pubkey',
        kind: 34601,
        byteSize: chunkBytes,
        created_at: 2
      },
      {
        ref: 'chunk-2',
        id: 'chunk-2-id',
        pubkey,
        ownerType: 'pubkey',
        kind: 34601,
        byteSize: chunkBytes,
        created_at: 3
      }
    ])
    await mdb.index('pendingOps').addDocuments([
      pruneOp({ limit: 112 })
    ])

    await processAllPending()

    assert.equal((await mdb.index('events').getDocument('old-text')).id, 'old-text-id')
    await assert.rejects(mdb.index('events').getDocument('chunk-1'))
    await assert.rejects(mdb.index('events').getDocument('chunk-2'))
    assert.equal(
      (await mdb.index('storedEventOwners').getDocument(pubkey)).usedBytes,
      100
    )
  })

  it('deletes ordinary events from the oldest forward', async () => {
    const events = Array.from({ length: 101 }, (_, index) => ({
      ref: `ordered-${index + 1}`,
      id: `ordered-id-${index + 1}`,
      pubkey,
      ownerType: 'pubkey',
      kind: 1,
      byteSize: 1,
      created_at: index + 1
    }))
    await seedOwner({ usedBytes: events.length })
    await mdb.index('events').addDocuments(events)
    await mdb.index('pendingOps').addDocuments([
      pruneOp({ key: 'ordered-prune', limit: 2 })
    ])

    await processAllPending()

    await assert.rejects(mdb.index('events').getDocument('ordered-1'))
    assert.equal(
      (await mdb.index('events').getDocument('ordered-101')).id,
      'ordered-id-101'
    )
    assert.equal(
      (await mdb.index('storedEventOwners').getDocument(pubkey)).usedBytes,
      1
    )
  })

  it('resumes accounting when the post-delete phase update fails', async () => {
    await seedOwner({ usedBytes: 500 })
    await mdb.index('events').addDocuments([{
      ref: 'phase-crash',
      id: 'phase-crash-id',
      pubkey,
      ownerType: 'pubkey',
      kind: 1,
      byteSize: 200,
      created_at: 1
    }])
    await mdb.index('pendingOps').addDocuments([
      pruneOp({ key: 'phase-crash-op', limit: 300 })
    ])
    const op = (await pendingOps())[0]
    const pendingIndex = mdb.index('pendingOps')
    const originalUpdate = pendingIndex.updateDocuments.bind(pendingIndex)
    const updateMock = mock.method(pendingIndex, 'updateDocuments', async docs => {
      if (docs[0]?.phase === 'events_applied') {
        throw new TypeError('simulated phase persistence failure')
      }
      return originalUpdate(docs)
    })
    const errorMock = mock.method(console, 'error', () => {})
    try {
      await assert.rejects(
        processBatch([op], await loadSystemState()),
        /simulated phase persistence failure/
      )
    } finally {
      updateMock.mock.restore()
      errorMock.mock.restore()
    }

    await assert.rejects(mdb.index('events').getDocument('phase-crash'))
    assert.equal(
      (await mdb.index('pendingOps').getDocument(op.key)).phase,
      'prepared'
    )
    assert.equal(
      (await mdb.index('storedEventOwners').getDocument(pubkey)).usedBytes,
      500
    )

    await processAllPending()
    assert.equal(
      (await mdb.index('storedEventOwners').getDocument(pubkey)).usedBytes,
      0
    )
  })

  it('does not apply an owner delta twice after an accounting interruption', async () => {
    await seedOwner({ usedBytes: 500 })
    await mdb.index('events').addDocuments([{
      ref: 'accounting-crash',
      id: 'accounting-crash-id',
      pubkey,
      ownerType: 'pubkey',
      kind: 1,
      byteSize: 200,
      created_at: 1
    }])
    await mdb.index('pendingOps').addDocuments([
      pruneOp({ key: 'accounting-crash-op', limit: 300 })
    ])
    const op = (await pendingOps())[0]
    const ownerIndex = mdb.index('storedEventOwners')
    const originalEdit =
      ownerIndex.updateDocumentsByFunction.bind(ownerIndex)
    let failed = false
    const editMock = mock.method(
      ownerIndex,
      'updateDocumentsByFunction',
      async options => {
        const result = await originalEdit(options)
        if (!failed &&
            options.context?.entries &&
            options.function.includes('next_bytes')) {
          failed = true
          throw new TypeError('simulated accounting acknowledgement loss')
        }
        return result
      }
    )
    const errorMock = mock.method(console, 'error', () => {})
    try {
      await assert.rejects(
        processBatch([op], await loadSystemState()),
        /simulated accounting acknowledgement loss/
      )
    } finally {
      editMock.mock.restore()
      errorMock.mock.restore()
    }

    let owner = await ownerIndex.getDocument(pubkey)
    assert.equal(owner.usedBytes, 300)
    assert.equal(owner.accountingTokens.length, 1)
    assert.equal(
      (await mdb.index('pendingOps').getDocument(op.key)).phase,
      'events_applied'
    )

    await processAllPending()
    owner = await ownerIndex.getDocument(pubkey)
    assert.equal(owner.usedBytes, 0)
    assert.deepEqual(owner.accountingTokens, [])
  })

  it('promotes popular IP events with exactly-once transfer accounting', async () => {
    const author = '2'.repeat(64)
    const ip = '198.51.100.10'
    const ownerKey = ipToPrimaryKey(ip)
    await markPopular(author)

    await seedOwner({
      key: ownerKey,
      entityType: 'ip',
      usedBytes: 200,
      lastActiveAt: 1
    })
    await mdb.index('events').addDocuments([{
      ref: 'popular-ip-event',
      id: 'popular-ip-event-id',
      pubkey: author,
      ip,
      ownerType: 'ip',
      kind: 1,
      byteSize: 200,
      created_at: 1
    }])
    await mdb.index('pendingOps').addDocuments([
      pruneOp({
        ownerKey,
        ownerType: 'ip',
        limit: 0
      })
    ])

    await processAllPending()

    const event = await mdb.index('events').getDocument('popular-ip-event')
    assert.equal(event.ownerType, 'pubkey')
    assert.equal(event.popularityLevel, 1)
    assert.equal(
      (await mdb.index('storedEventOwners').getDocument(ownerKey)).usedBytes,
      0
    )
    const destination =
      await mdb.index('storedEventOwners').getDocument(author)
    assert.equal(destination.usedBytes, 200)
    assert.equal(destination.popularityLevel, 1)
    assert.deepEqual(destination.accountingTokens, [])
  })

  it('does not repeat grouped promotion accounting after acknowledgement loss', async () => {
    const author = '6'.repeat(64)
    const ip = '198.51.100.11'
    const ownerKey = ipToPrimaryKey(ip)
    await markPopular(author)
    await seedOwner({
      key: ownerKey,
      entityType: 'ip',
      usedBytes: 200,
      lastActiveAt: 1
    })
    await seedOwner({
      key: author,
      entityType: 'pubkey',
      usedBytes: 0,
      popularityLevel: 1
    })
    await mdb.index('events').addDocuments([{
      ref: 'partially-accounted-promotion',
      id: 'partially-accounted-promotion-id',
      pubkey: author,
      ip,
      ownerType: 'ip',
      kind: 1,
      byteSize: 200,
      created_at: 1
    }])
    await mdb.index('pendingOps').addDocuments([
      pruneOp({
        key: 'partially-accounted-promotion-op',
        ownerKey,
        ownerType: 'ip',
        limit: 0
      })
    ])

    const op = (await pendingOps())[0]
    const ownerIndex = mdb.index('storedEventOwners')
    const originalEdit =
      ownerIndex.updateDocumentsByFunction.bind(ownerIndex)
    let interrupted = false
    const editMock = mock.method(
      ownerIndex,
      'updateDocumentsByFunction',
      async options => {
        const result = await originalEdit(options)
        if (!interrupted &&
            options.context?.entries &&
            options.function.includes('next_bytes')) {
          interrupted = true
          throw new TypeError('simulated source accounting interruption')
        }
        return result
      }
    )
    const errorMock = mock.method(console, 'error', () => {})
    try {
      await assert.rejects(
        processBatch([op], await loadSystemState()),
        /simulated source accounting interruption/
      )
    } finally {
      editMock.mock.restore()
      errorMock.mock.restore()
    }

    assert.equal(
      (await ownerIndex.getDocument(ownerKey)).usedBytes,
      0
    )
    assert.equal((await ownerIndex.getDocument(author)).usedBytes, 200)
    assert.equal(
      (await mdb.index('pendingOps').getDocument(op.key)).phase,
      'events_applied'
    )

    await processAllPending()

    assert.equal((await ownerIndex.getDocument(ownerKey)).usedBytes, 0)
    assert.equal((await ownerIndex.getDocument(author)).usedBytes, 200)
    assert.deepEqual(
      (await ownerIndex.getDocument(ownerKey)).accountingTokens,
      []
    )
    assert.deepEqual(
      (await ownerIndex.getDocument(author)).accountingTokens,
      []
    )
  })

  it('resumes a partially applied v1 owner transfer without double subtraction', async () => {
    const author = '8'.repeat(64)
    const ip = '198.51.100.13'
    const ownerKey = ipToPrimaryKey(ip)
    const effectKey = 'partial-v1-transfer:0'
    await seedOwner({
      key: ownerKey,
      entityType: 'ip',
      usedBytes: 0,
      lastActiveAt: 1
    })
    await mdb.index('storedEventOwners').updateDocuments([{
      key: ownerKey,
      accountingTokens: [`${effectKey}:${ownerKey}`]
    }])
    await mdb.index('events').addDocuments([{
      ref: 'partial-v1-event',
      id: 'partial-v1-event-id',
      pubkey: author,
      ip,
      ownerType: 'pubkey',
      popularityLevel: 1,
      kind: 1,
      byteSize: 200,
      created_at: 1
    }])
    const action = {
      ref: 'partial-v1-event',
      id: 'partial-v1-event-id',
      kind: 1,
      pubkey: author,
      byteSize: 200,
      ownerKey,
      ownerType: 'ip',
      action: 'promote',
      destinationOwnerKey: author,
      destinationPopularityLevel: 1
    }
    await mdb.index('pendingOps').addDocuments([{
      ...pruneOp({
        key: 'partial-v1-transfer',
        ownerKey,
        ownerType: 'ip',
        limit: 0,
        data: {
          workflowVersion: 1,
          effectKey,
          actions: [action],
          applied: [action]
        }
      }),
      phase: 'events_applied',
      startedAt: 1
    }])

    await processAllPending()

    const source = await mdb.index('storedEventOwners').getDocument(ownerKey)
    const destination =
      await mdb.index('storedEventOwners').getDocument(author)
    assert.equal(source.usedBytes, 0)
    assert.deepEqual(source.accountingTokens, [])
    assert.equal(destination.usedBytes, 200)
    assert.deepEqual(destination.accountingTokens, [])
  })

  it('reuses the destination check after token-cleanup acknowledgement loss', async () => {
    const author = 'a'.repeat(64)
    const ip = '198.51.100.16'
    const ownerKey = ipToPrimaryKey(ip)
    await markPopular(author)
    await seedOwner({
      key: ownerKey,
      entityType: 'ip',
      usedBytes: 200,
      lastActiveAt: 1
    })
    await mdb.index('events').addDocuments([{
      ref: 'cleanup-ack-promotion',
      id: 'cleanup-ack-promotion-id',
      pubkey: author,
      ip,
      ownerType: 'ip',
      kind: 1,
      byteSize: 200,
      created_at: 1
    }])
    const op = pruneOp({
      key: 'cleanup-ack-prune',
      ownerKey,
      ownerType: 'ip',
      limit: 0
    })
    await mdb.index('pendingOps').addDocuments([op])

    const ownerIndex = mdb.index('storedEventOwners')
    const originalEdit =
      ownerIndex.updateDocumentsByFunction.bind(ownerIndex)
    let interrupted = false
    const editMock = mock.method(
      ownerIndex,
      'updateDocumentsByFunction',
      async options => {
        const result = await originalEdit(options)
        if (!interrupted && options.function.includes('let remaining')) {
          interrupted = true
          throw new TypeError('simulated cleanup acknowledgement loss')
        }
        return result
      }
    )
    const errorMock = mock.method(console, 'error', () => {})
    try {
      await assert.rejects(
        processBatch([op], await loadSystemState()),
        /simulated cleanup acknowledgement loss/
      )
    } finally {
      editMock.mock.restore()
      errorMock.mock.restore()
    }

    const afterFailure = await pendingOps()
    assert.equal(afterFailure.filter(pending =>
      pending.source === 'prunePromotion'
    ).length, 1)
    assert.equal(
      (await mdb.index('pendingOps').getDocument(op.key)).phase,
      'accounting_applied'
    )

    await processAllPending()

    assert.equal(
      (await mdb.index('storedEventOwners').getDocument(author)).usedBytes,
      200
    )
    assert.deepEqual(
      (await mdb.index('storedEventOwners').getDocument(author))
        .accountingTokens,
      []
    )
  })

  it('queues a limit check for every promoted destination', async () => {
    const ONE_MB = 1024 * 1024
    const author = '7'.repeat(64)
    const ip = '198.51.100.12'
    const ownerKey = ipToPrimaryKey(ip)
    const promotedBytes = 60 * ONE_MB
    await markPopular(author)
    await seedOwner({
      key: ownerKey,
      entityType: 'ip',
      usedBytes: promotedBytes,
      lastActiveAt: 1
    })
    await seedOwner({
      key: author,
      entityType: 'pubkey',
      usedBytes: 0,
      popularityLevel: 1
    })
    await mdb.index('events').addDocuments([{
      ref: 'promotion-near-quota',
      id: 'promotion-near-quota-id',
      pubkey: author,
      ip,
      ownerType: 'ip',
      kind: 1,
      byteSize: promotedBytes,
      created_at: 1
    }])
    await mdb.index('pendingOps').addDocuments([
      pruneOp({
        key: 'promotion-near-quota-op',
        ownerKey,
        ownerType: 'ip',
        limit: 0
      })
    ])

    const initial = await pendingOps()
    await processBatch(initial, await loadSystemState())

    const remaining = await pendingOps()
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].type, 'pruneCheck')
    assert.equal(remaining[0].data.key, author)
    assert.equal(remaining[0].data.entityType, 'pubkey')
    assert.equal(remaining[0].data.limit, 500 * ONE_MB)
    assert.equal(remaining[0].data.resolveLimitFromOwner, true)
    assert.equal(remaining[0].data.targetBytes, 450 * ONE_MB)
  })

  it('resolves a promoted destination limit from its current popularity', async () => {
    const ONE_MB = 1024 * 1024
    const author = '9'.repeat(64)
    await seedOwner({
      key: author,
      entityType: 'pubkey',
      usedBytes: 30 * ONE_MB,
      popularityLevel: 5
    })
    await mdb.index('events').addDocuments([{
      ref: 'changed-popularity',
      id: 'changed-popularity-id',
      pubkey: author,
      ownerType: 'pubkey',
      popularityLevel: 5,
      kind: 1,
      byteSize: 30 * ONE_MB,
      created_at: 1
    }])
    await queuePruneCheckOnce({
      ownerKey: author,
      ownerType: 'pubkey',
      limit: 500 * ONE_MB,
      popularityLevel: 1,
      source: 'prunePromotion',
      dedupeScope: 'prune-promotion-destination',
      resolveLimitFromOwner: true
    })

    await processAllPending()

    await assert.rejects(
      mdb.index('events').getDocument('changed-popularity')
    )
    assert.equal(
      (await mdb.index('storedEventOwners').getDocument(author)).usedBytes,
      0
    )
  })

  it('promotes 100 events and queues all distinct destinations in one step', async () => {
    const ip = '198.51.100.15'
    const ownerKey = ipToPrimaryKey(ip)
    const authors = Array.from(
      { length: 100 },
      (_, index) => (index + 100).toString(16).padStart(64, '0')
    )
    await markPopularMany(authors)
    await seedOwner({
      key: ownerKey,
      entityType: 'ip',
      usedBytes: authors.length,
      lastActiveAt: 1
    })
    await mdb.index('events').addDocuments(
      authors.map((author, index) => ({
        ref: `hundred-promotions-${index}`,
        id: `hundred-promotions-id-${index}`,
        pubkey: author,
        ip,
        ownerType: 'ip',
        kind: 1,
        byteSize: 1,
        created_at: index
      }))
    )
    const op = pruneOp({
      key: 'hundred-promotions-prune',
      ownerKey,
      ownerType: 'ip',
      limit: 0
    })
    await mdb.index('pendingOps').addDocuments([op])

    await processBatch([op], await loadSystemState())

    assert.equal(
      (await mdb.index('events').getDocument('hundred-promotions-0'))
        .ownerType,
      'pubkey'
    )
    assert.equal(
      (await mdb.index('events').getDocument('hundred-promotions-99'))
        .ownerType,
      'pubkey'
    )
    assert.equal(
      (await pendingOps()).filter(pending =>
        pending.source === 'prunePromotion'
      ).length,
      authors.length
    )
  })

  it('handles multiple prune checks for the same owner without double accounting', async () => {
    await seedOwner({ usedBytes: 200 })
    await mdb.index('events').addDocuments([{
      ref: 'duplicate-prune-event',
      id: 'duplicate-prune-event-id',
      pubkey,
      ownerType: 'pubkey',
      kind: 1,
      byteSize: 200,
      created_at: 1
    }])
    await mdb.index('pendingOps').addDocuments([
      pruneOp({ key: 'duplicate-prune-a', limit: 0 }),
      {
        ...pruneOp({ key: 'duplicate-prune-b', limit: 0 }),
        position: 1
      }
    ])

    await processAllPending()

    await assert.rejects(
      mdb.index('events').getDocument('duplicate-prune-event')
    )
    const owner = await mdb.index('storedEventOwners').getDocument(pubkey)
    assert.equal(owner.usedBytes, 0)
    assert.deepEqual(owner.accountingTokens, [])
  })

  it('coalesces only queued prune checks with identical semantics', () => {
    const first = pruneOp({ key: 'coalesce-a', limit: 100 })
    const duplicate = pruneOp({ key: 'coalesce-b', limit: 100 })
    const differentLimit = pruneOp({ key: 'coalesce-c', limit: 101 })
    const active = {
      ...pruneOp({ key: 'coalesce-d', limit: 100 }),
      phase: 'prepared'
    }

    assert.equal(
      getPruneCheckCoalescingKey(first),
      getPruneCheckCoalescingKey(duplicate)
    )
    assert.notEqual(
      getPruneCheckCoalescingKey(first),
      getPruneCheckCoalescingKey(differentLimit)
    )
    assert.equal(getPruneCheckCoalescingKey(active), null)
  })

  it('processes at most one prune step per owner in a batch', async () => {
    await seedOwner({ usedBytes: 100 })
    await mdb.index('events').addDocuments([{
      ref: 'single-owner-step',
      id: 'single-owner-step-id',
      pubkey,
      ownerType: 'pubkey',
      kind: 1,
      byteSize: 100,
      created_at: 1
    }])
    const first = pruneOp({ key: 'single-owner-first', limit: 0 })
    const second = {
      ...pruneOp({ key: 'single-owner-second', limit: 1 }),
      position: 1
    }
    await mdb.index('pendingOps').addDocuments([first, second])

    await processBatch(await pendingOps(), await loadSystemState())

    await assert.rejects(mdb.index('pendingOps').getDocument(first.key))
    assert.equal(
      (await mdb.index('pendingOps').getDocument(second.key)).phase,
      'queued'
    )
  })

  it('uses at most 12 Meilisearch mutations for a mixed 100-event step', async () => {
    const ip = '198.51.100.14'
    const ownerKey = ipToPrimaryKey(ip)
    const popularAuthors = Array.from(
      { length: 50 },
      (_, index) => (index + 10).toString(16).padStart(64, '0')
    )
    await markPopularMany(popularAuthors)
    await seedOwner({
      key: ownerKey,
      entityType: 'ip',
      usedBytes: 100,
      lastActiveAt: 1
    })
    await mdb.index('events').addDocuments([
      ...popularAuthors.map((author, index) => ({
        ref: `batched-promotion-${index}`,
        id: `batched-promotion-id-${index}`,
        pubkey: author,
        ip,
        ownerType: 'ip',
        kind: 1,
        byteSize: 1,
        created_at: index
      })),
      ...Array.from({ length: 50 }, (_, index) => ({
        ref: `batched-deletion-${index}`,
        id: `batched-deletion-id-${index}`,
        pubkey: 'f'.repeat(64),
        ip,
        ownerType: 'ip',
        kind: 1,
        byteSize: 1,
        created_at: index + 50
      }))
    ])
    const op = pruneOp({
      key: 'batched-mixed-prune',
      ownerKey,
      ownerType: 'ip',
      limit: 0
    })
    await mdb.index('pendingOps').addDocuments([op])

    let mutationCount = 0
    const mutationMocks = []
    for (const indexName of ['events', 'storedEventOwners', 'pendingOps']) {
      const index = mdb.index(indexName)
      for (const method of [
        'addDocuments',
        'updateDocuments',
        'deleteDocuments',
        'deleteDocument',
        'updateDocumentsByFunction'
      ]) {
        const original = index[method].bind(index)
        mutationMocks.push(mock.method(index, method, (...args) => {
          mutationCount++
          return original(...args)
        }))
      }
    }
    try {
      await processBatch([op], await loadSystemState())
    } finally {
      for (const mutationMock of mutationMocks) mutationMock.mock.restore()
    }

    assert.ok(
      mutationCount <= 12,
      `expected at most 12 mutations, received ${mutationCount}`
    )
    const remaining = await pendingOps()
    assert.equal(
      remaining.filter(pending => pending.source === 'prunePromotion').length,
      popularAuthors.length
    )
  })

  it('applies simple writes before a legacy check in the same segment', async () => {
    const ownerKey = 'legacy-owner'
    await seedOwner({ key: ownerKey, usedBytes: 100 })
    const legacy = pruneOp({
      key: 'legacy-prune',
      ownerKey,
      limit: 0
    })
    delete legacy.data.workflowVersion
    delete legacy.data.step
    legacy.position = 0
    const insert = {
      key: 'legacy-insert',
      type: 'insertOrReplaceDocument',
      phase: 'queued',
      createdAt: 1,
      batchId: legacy.batchId,
      position: 1,
      data: {
        index: 'events',
        document: {
          ref: 'legacy-event',
          id: 'legacy-event-id',
          pubkey: ownerKey,
          ownerType: 'pubkey',
          kind: 1,
          byteSize: 100,
          created_at: 1
        }
      }
    }
    await mdb.index('pendingOps').addDocuments([legacy, insert])

    await processBatch(await pendingOps(), await loadSystemState())

    await assert.rejects(mdb.index('pendingOps').getDocument(legacy.key))
    await assert.rejects(mdb.index('events').getDocument('legacy-event'))
    assert.equal(
      (await mdb.index('storedEventOwners').getDocument(ownerKey)).usedBytes,
      0
    )
  })

  it('deduplicates stale-IP requests and cancels one after renewed activity', async () => {
    const ip = '203.0.113.9'
    const ownerKey = ipToPrimaryKey(ip)
    await seedOwner({
      key: ownerKey,
      entityType: 'ip',
      usedBytes: 100,
      lastActiveAt: 10
    })
    await mdb.index('events').addDocuments([{
      ref: 'renewed-event',
      id: 'renewed-event-id',
      pubkey: '3'.repeat(64),
      ip,
      ownerType: 'ip',
      kind: 1,
      byteSize: 100,
      created_at: 1
    }])

    const request = {
      ownerKey,
      ownerType: 'ip',
      limit: 0,
      deleteOwnerWhenEmpty: true,
      staleIfLastActiveAtLte: 10,
      source: 'deleteStaleIps',
      dedupeScope: 'delete-stale-ip'
    }
    const first = await queuePruneCheckOnce(request)
    const second = await queuePruneCheckOnce(request)
    assert.equal(first.key, second.key)
    assert.equal(first.queued, true)
    assert.equal(second.queued, false)
    assert.equal((await pendingOps()).length, 1)

    await mdb.index('storedEventOwners').updateDocuments([{
      key: ownerKey,
      lastActiveAt: 11
    }])
    await processAllPending()

    assert.equal(
      (await mdb.index('events').getDocument('renewed-event')).id,
      'renewed-event-id'
    )
    assert.equal(
      (await mdb.index('storedEventOwners').getDocument(ownerKey)).lastActiveAt,
      11
    )
  })

  it('cancels persisted stale-IP intent if activity resumes before mutation', async () => {
    const ip = '203.0.113.10'
    const ownerKey = ipToPrimaryKey(ip)
    const author = '4'.repeat(64)
    await seedOwner({
      key: ownerKey,
      entityType: 'ip',
      usedBytes: 100,
      lastActiveAt: 11
    })
    await mdb.index('events').addDocuments([{
      ref: 'reactivated-after-prepare',
      id: 'reactivated-after-prepare-id',
      pubkey: author,
      ip,
      ownerType: 'ip',
      kind: 1,
      byteSize: 100,
      created_at: 1
    }])
    await mdb.index('pendingOps').addDocuments([{
      ...pruneOp({
        key: 'reactivated-after-prepare-op',
        ownerKey,
        ownerType: 'ip',
        limit: 0,
        data: {
          staleIfLastActiveAtLte: 10,
          deleteOwnerWhenEmpty: true,
          effectKey: 'reactivated-after-prepare-op:0',
          actions: [{
            ref: 'reactivated-after-prepare',
            id: 'reactivated-after-prepare-id',
            kind: 1,
            pubkey: author,
            byteSize: 100,
            ownerKey,
            ownerType: 'ip',
            action: 'delete'
          }]
        }
      }),
      phase: 'prepared',
      startedAt: 1
    }])

    await processAllPending()

    assert.equal(
      (await mdb.index('events').getDocument('reactivated-after-prepare')).id,
      'reactivated-after-prepare-id'
    )
    assert.equal(
      (await mdb.index('storedEventOwners').getDocument(ownerKey)).usedBytes,
      100
    )
  })

  it('does not remove an empty stale owner that reactivates before deletion', async () => {
    const ip = '203.0.113.11'
    const ownerKey = ipToPrimaryKey(ip)
    await seedOwner({
      key: ownerKey,
      entityType: 'ip',
      usedBytes: 100,
      lastActiveAt: 10
    })
    await mdb.index('events').addDocuments([{
      ref: 'reactivated-before-owner-delete',
      id: 'reactivated-before-owner-delete-id',
      pubkey: '5'.repeat(64),
      ip,
      ownerType: 'ip',
      kind: 1,
      byteSize: 100,
      created_at: 1
    }])
    await mdb.index('pendingOps').addDocuments([
      pruneOp({
        key: 'reactivated-before-owner-delete-op',
        ownerKey,
        ownerType: 'ip',
        limit: 0,
        data: {
          staleIfLastActiveAtLte: 10,
          deleteOwnerWhenEmpty: true
        }
      })
    ])

    const ownerIndex = mdb.index('storedEventOwners')
    const originalEdit =
      ownerIndex.updateDocumentsByFunction.bind(ownerIndex)
    let reactivated = false
    const editMock = mock.method(
      ownerIndex,
      'updateDocumentsByFunction',
      async options => {
        if (!reactivated &&
            options.context?.staleIfLastActiveAtLte === 10) {
          reactivated = true
          await ownerIndex.updateDocuments([{
            key: ownerKey,
            lastActiveAt: 11
          }])
        }
        return originalEdit(options)
      }
    )
    try {
      await processAllPending()
    } finally {
      editMock.mock.restore()
    }

    const owner = await ownerIndex.getDocument(ownerKey)
    assert.equal(owner.usedBytes, 0)
    assert.equal(owner.lastActiveAt, 11)
  })

  it('places new prune checks after every other operation in a logical batch', async () => {
    await queueOps([
      { type: 'deltaUsage', data: { key: pubkey, delta: 1 } },
      {
        type: 'pruneCheck',
        data: {
          key: pubkey,
          entityType: 'pubkey',
          limit: 0,
          workflowVersion: 1
        }
      },
      {
        type: 'insertOrReplaceDocument',
        data: { index: 'events', document: { ref: 'last-write' } }
      }
    ])

    assert.deepEqual(
      (await pendingOps()).map(op => op.type),
      ['deltaUsage', 'insertOrReplaceDocument', 'pruneCheck']
    )
  })
})
