import { describe, it, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { eventKinds } from '#constants/event.js'

// Helper for valid hex strings
const pad64 = (s) => s.padStart(64, '0')
const pad128 = (s) => s.padStart(128, '0')

const VALID_ID_1 = pad64('1')
const VALID_PUBKEY_1 = pad64('2')
const VALID_SIG = pad128('3')

const VALID_ID_DEL = pad64('a')
const VALID_ID_TARGET_1 = pad64('b')
const VALID_PUBKEY_DEL = pad64('c')

const VALID_ID_REPL_OLD = pad64('10')
const VALID_ID_REPL_NEW = pad64('11')
const VALID_PUBKEY_REPL = pad64('20')

describe('EventSaver (MDB) Integration', () => {
  let EventSaver
  let mdb
  let queueOpsMock
  let checkStorageLimitAndPruneMock

  before(async () => {
    // Verify mocks setup
    queueOpsMock = mock.fn(async () => {})
    checkStorageLimitAndPruneMock = mock.fn(async ({ pubkey }) => ({
      ownerType: 'pubkey',
      ownerKey: pubkey,
      popularityLevel: 1,
      ops: []
    }))

    mock.module('#services/event/maintainer/mdb/index.js', {
      namedExports: {
        queueOps: queueOpsMock,
        checkStorageLimitAndPrune: checkStorageLimitAndPruneMock
      }
    })

    // Mock Deta to avoid initialization
    mock.module('#services/db/deta.js', {
      namedExports: { generateKey: () => 'mockKey' },
      defaultExport: {}
    })

    EventSaver = (await import('#services/event/saver/mdb/index.js')).default
    mdb = (await import('#services/db/mdb.js')).default
  })

  after(async () => {
    mock.restoreAll()
  })

  beforeEach(async () => {
    // Reset mocks
    queueOpsMock.mock.resetCalls()
    checkStorageLimitAndPruneMock.mock.resetCalls()

    // Clear DB index 'events' for fresh start
    await mdb.index('events').deleteAllDocuments()
  })

  it('should save a regular event correctly', async () => {
    const event = {
      id: VALID_ID_1,
      pubkey: VALID_PUBKEY_1,
      created_at: 1000,
      kind: 1,
      tags: [],
      content: 'hello',
      sig: VALID_SIG
    }
    const ip = '127.0.0.1'

    checkStorageLimitAndPruneMock.mock.mockImplementation(async () => ({
      ownerType: 'pubkey',
      ownerKey: VALID_PUBKEY_1,
      popularityLevel: 1,
      ops: [{ type: 'mockOp' }]
    }))

    const result = await EventSaver.run({ ws: {}, event, ip })

    assert.ok(result.isSuccess)
    assert.equal(queueOpsMock.mock.calls.length, 1)

    // Verify it generates proper ops
    const ops = queueOpsMock.mock.calls[0].arguments[0]
    const insertOp = ops.find(op => op.type === 'insertOrReplaceDocument')
    assert.ok(insertOp)
    assert.equal(insertOp.data.document.id, VALID_ID_1)
  })

  it('should fail if deletion event targets a deletion event', async () => {
    // Seed real data to Meilisearch
    const eventToDelete = {
      id: VALID_ID_TARGET_1,
      pubkey: VALID_PUBKEY_DEL,
      created_at: 1000,
      kind: 1,
      tags: [],
      content: 'persist',
      sig: VALID_SIG
    }

    // Note: We need to use valid MDB record structure + our extra fields
    const { eventToRecord } = await import('#models/event/mapper.js')
    const record = eventToRecord(eventToDelete, { receivedAt: 1000 })

    // Also seed a kind 5 event
    const kind5Event = {
      id: pad64('a5'),
      pubkey: VALID_PUBKEY_DEL,
      kind: 5,
      tags: [],
      created_at: 500,
      content: '',
      sig: VALID_SIG
    }
    const kind5Record = eventToRecord(kind5Event, { receivedAt: 500 })

    await mdb.index('events').addDocuments([
      {
        ...record,
        byteSize: 100,
        ownerType: 'pubkey',
        ip: '127.0.0.1'
      },
      {
        ...kind5Record,
        byteSize: 100,
        ownerType: 'pubkey',
        ip: '127.0.0.1'
      }
    ])

    // Deletion Event targeting BOTH (should fail because one is kind 5)
    const deleteEvent = {
      id: VALID_ID_DEL,
      pubkey: VALID_PUBKEY_DEL,
      kind: eventKinds.DELETION,
      tags: [['e', VALID_ID_TARGET_1], ['e', kind5Event.id]],
      created_at: 2000,
      content: '',
      sig: VALID_SIG
    }

    const result = await EventSaver.run({ ws: {}, event: deleteEvent, ip: '1.2.3.4' })
    assert.equal(result.isSuccess, false)
    assert.equal(result.message, 'invalid: some events to delete do not belong to the author or are deletion events')
  })

  it('should replace event and handle usage update', async () => {
    // Seed Old Event
    const oldEvent = {
      id: VALID_ID_REPL_OLD,
      kind: 0,
      pubkey: VALID_PUBKEY_REPL,
      created_at: 1000,
      content: 'old',
      tags: [],
      sig: VALID_SIG
    }

    const { eventToRecord } = await import('#models/event/mapper.js')
    const oldRecord = eventToRecord(oldEvent, { receivedAt: 1000 })

    await mdb.index('events').addDocuments([{
      ...oldRecord,
      byteSize: 200,
      ownerType: 'pubkey',
      ip: '1.1.1.1'
    }])

    // New Event
    const newEvent = {
      id: VALID_ID_REPL_NEW,
      kind: 0,
      pubkey: VALID_PUBKEY_REPL,
      created_at: 2000,
      content: 'new',
      tags: [],
      sig: VALID_SIG
    }

    checkStorageLimitAndPruneMock.mock.mockImplementation(async () => ({
      ownerType: 'pubkey',
      ownerKey: VALID_PUBKEY_REPL,
      popularityLevel: 1,
      ops: []
    }))

    const result = await EventSaver.run({ ws: {}, event: newEvent, ip: '1.1.1.1' })
    assert.ok(result.isSuccess)

    const ops = queueOpsMock.mock.calls[0].arguments[0]
    const usageOp = ops.find(op => op.type === 'deltaUsage' && op.data.delta === -200)
    assert.ok(usageOp, 'Should subtract old usage')
  })

  it('should not allow saving an event if a deletion request exists from the same author', async () => {
    // 1. Seed a deletion request (kind 5) from author that targets VALID_ID_1
    const deleteRequestEvent = {
      id: pad64('d1'),
      pubkey: VALID_PUBKEY_1,
      kind: eventKinds.DELETION,
      tags: [['e', VALID_ID_1]],
      created_at: 500,
      content: '',
      sig: VALID_SIG
    }
    const { eventToRecord } = await import('#models/event/mapper.js')
    const record = eventToRecord(deleteRequestEvent, { receivedAt: 500 })

    await mdb.index('events').addDocuments([{
      ...record,
      byteSize: 100,
      ownerType: 'pubkey',
      ip: '1.2.3.4'
    }])

    // 2. Try to save the event that was requested to be deleted
    const event = {
      id: VALID_ID_1,
      pubkey: VALID_PUBKEY_1,
      created_at: 1000,
      kind: 1,
      tags: [],
      content: 'I should be rejected',
      sig: VALID_SIG
    }

    const result = await EventSaver.run({ ws: {}, event, ip: '1.2.3.4' })

    assert.equal(result.isSuccess, false)
    assert.equal(result.message, 'invalid: the author requested the deletion of the event you just tried to store')
    assert.equal(queueOpsMock.mock.calls.length, 0, 'No ops should be queued')
  })

  it('should return isDuplicate: true for an already existing event', async () => {
    const event = {
      id: VALID_ID_1,
      pubkey: VALID_PUBKEY_1,
      created_at: 1000,
      kind: 1,
      tags: [],
      content: 'hello',
      sig: VALID_SIG
    }

    // Seed the event
    const { eventToRecord } = await import('#models/event/mapper.js')
    const record = eventToRecord(event, { receivedAt: 1000 })
    await mdb.index('events').addDocuments([{
      ...record,
      byteSize: 100,
      ownerType: 'pubkey',
      ip: '1.2.3.4'
    }])

    const result = await EventSaver.run({ ws: {}, event, ip: '1.2.3.4' })

    assert.ok(result.isSuccess)
    assert.ok(result.isDuplicate)
    assert.equal(result.message, 'duplicate: already have this event')
    assert.equal(queueOpsMock.mock.calls.length, 0, 'No ops should be queued for duplicates')
  })

  it('should not allow saving a replaceable event if a more recent version exists', async () => {
    const pubkey = pad64('d')
    const kind = 10000
    const dTag = 'test'

    // Seed a more recent event
    const { eventToRecord } = await import('#models/event/mapper.js')
    const existingEvent = {
      id: pad64('ff'),
      pubkey,
      created_at: 2000,
      kind,
      tags: [['d', dTag]],
      content: 'recent',
      sig: VALID_SIG
    }
    const record = eventToRecord(existingEvent, { receivedAt: 2000 })
    await mdb.index('events').addDocuments([{
      ...record,
      byteSize: 100,
      ownerType: 'pubkey',
      ip: '1.2.3.4'
    }])

    // Try to save an older one
    const olderEvent = {
      id: pad64('ee'),
      pubkey,
      created_at: 1000,
      kind,
      tags: [['d', dTag]],
      content: 'older',
      sig: VALID_SIG
    }

    const result = await EventSaver.run({ ws: {}, event: olderEvent, ip: '1.2.3.4' })

    assert.equal(result.isSuccess, false)
    assert.equal(result.message, 'invalid: there is a more recent event version')
  })

  it('should fail if deletion event has no valid tags', async () => {
    const deleteEvent = {
      id: pad64('de1'),
      pubkey: VALID_PUBKEY_DEL,
      kind: eventKinds.DELETION,
      tags: [['random', 'tag']],
      created_at: 2000,
      content: '',
      sig: VALID_SIG
    }

    const result = await EventSaver.run({ ws: {}, event: deleteEvent, ip: '1.2.3.4' })
    assert.equal(result.isSuccess, false)
    assert.equal(result.message, 'invalid: no ids or addresses to delete')
  })

  it('should fail if deletion event tries to delete a deletion event', async () => {
    const deleteEvent = {
      id: pad64('dc2'),
      pubkey: VALID_PUBKEY_DEL,
      kind: eventKinds.DELETION,
      tags: [['a', `5:${VALID_PUBKEY_DEL}:test`]],
      created_at: 2000,
      content: '',
      sig: VALID_SIG
    }

    const result = await EventSaver.run({ ws: {}, event: deleteEvent, ip: '1.2.3.4' })
    assert.equal(result.isSuccess, false)
    assert.equal(result.message, 'invalid: can\'t delete deletion events')
  })

  it('should fail if deletion event targets event from another author', async () => {
    // Seed event from another author
    const otherAuthor = pad64('bad')
    const eventToSteal = {
      id: pad64('573'),
      pubkey: otherAuthor,
      created_at: 1000,
      kind: 1,
      tags: [],
      content: 'not yours',
      sig: VALID_SIG
    }
    const { eventToRecord } = await import('#models/event/mapper.js')
    const record = eventToRecord(eventToSteal, { receivedAt: 1000 })
    await mdb.index('events').addDocuments([{
      ...record,
      byteSize: 100,
      ownerType: 'pubkey',
      ip: '1.2.3.4'
    }])

    const deleteEvent = {
      id: pad64('df4'),
      pubkey: VALID_PUBKEY_DEL,
      kind: eventKinds.DELETION,
      tags: [['e', eventToSteal.id]],
      created_at: 2000,
      content: '',
      sig: VALID_SIG
    }

    const result = await EventSaver.run({ ws: {}, event: deleteEvent, ip: '1.2.3.4' })
    assert.equal(result.isSuccess, false)
    assert.equal(result.message, 'invalid: some events to delete do not belong to the author or are deletion events')
  })

  it('should not delete a replaceable event if its created_at is greater than deletion event created_at', async () => {
    const pubkey = VALID_PUBKEY_DEL
    const dTag = 'future-replaceable'
    const kind = 10000 // replaceable

    // Seed the "future" replaceable event
    const { eventToRecord } = await import('#models/event/mapper.js')
    const replaceableEvent = {
      id: pad64('f1'),
      pubkey,
      created_at: 2000,
      kind,
      tags: [['d', dTag]],
      content: 'I am from the future',
      sig: VALID_SIG
    }
    const record = eventToRecord(replaceableEvent, { receivedAt: 2000 })
    await mdb.index('events').addDocuments([{
      ...record,
      byteSize: 100,
      ownerType: 'pubkey',
      ip: '1.2.3.4'
    }])

    // Deletion event from the past
    const deleteEvent = {
      id: pad64('d5'),
      pubkey,
      kind: eventKinds.DELETION,
      tags: [['a', `${kind}:${pubkey}:${dTag}`]],
      created_at: 1000, // Older than the replaceable event
      content: '',
      sig: VALID_SIG
    }

    const result = await EventSaver.run({ ws: {}, event: deleteEvent, ip: '1.2.3.4' })

    assert.ok(result.isSuccess)
    // 1 call: Saving the deletion event itself. 0 calls for actual deletions because of created_at check.
    assert.equal(queueOpsMock.mock.calls.length, 1)
    const allOps = queueOpsMock.mock.calls.flatMap(call => call.arguments[0])
    const deleteOps = allOps.filter(op => op.type === 'deleteDocumentIfExists')
    assert.equal(deleteOps.length, 0, 'Should not have any delete ops')
  })

  it('should delete a replaceable event if its created_at is equal to deletion event created_at', async () => {
    const pubkey = VALID_PUBKEY_DEL
    const dTag = 'current-replaceable'
    const kind = 10000

    // Seed the replaceable event
    const { eventToRecord } = await import('#models/event/mapper.js')
    const replaceableEvent = {
      id: pad64('f2'),
      pubkey,
      created_at: 1000,
      kind,
      tags: [['d', dTag]],
      content: 'I am current',
      sig: VALID_SIG
    }
    const record = eventToRecord(replaceableEvent, { receivedAt: 1000 })
    await mdb.index('events').addDocuments([{
      ...record,
      byteSize: 100,
      ownerType: 'pubkey',
      ip: '1.2.3.4'
    }])

    // Deletion event with same created_at
    const deleteEvent = {
      id: pad64('d6'),
      pubkey,
      kind: eventKinds.DELETION,
      tags: [['a', `${kind}:${pubkey}:${dTag}`]],
      created_at: 1000,
      content: '',
      sig: VALID_SIG
    }

    const result = await EventSaver.run({ ws: {}, event: deleteEvent, ip: '1.2.3.4' })

    assert.ok(result.isSuccess)
    // 2 calls: one from handleDelete for the deletion, one for saving the deletion event itself
    assert.equal(queueOpsMock.mock.calls.length, 2)
    const allOps = queueOpsMock.mock.calls.flatMap(call => call.arguments[0])
    const deleteOp = allOps.find(op => op.type === 'deleteDocumentIfExists')
    assert.ok(deleteOp)
    assert.equal(deleteOp.data.key, record.ref)
  })

  it('should handle VIP event correctly (simulated by mock)', async () => {
    const vipPubkey = pad64('aa')

    checkStorageLimitAndPruneMock.mock.mockImplementation(async () => ({
      ownerType: 'pubkey',
      ownerKey: vipPubkey,
      popularityLevel: 999,
      ops: [{ type: 'deltaUsage', data: { targetKey: vipPubkey, delta: 100, entityType: 'pubkey', popularityLevel: 999 } }]
    }))

    const event = {
      id: pad64('bb'),
      pubkey: vipPubkey,
      created_at: 3000,
      kind: 1,
      tags: [],
      content: 'vip content',
      sig: VALID_SIG
    }

    const result = await EventSaver.run({ ws: {}, event, ip: '9.9.9.9' })

    assert.ok(result.isSuccess)
    const ops = queueOpsMock.mock.calls[0].arguments[0]

    // Verify it queues usage update for the pubkey
    const usageOp = ops.find(op => op.type === 'deltaUsage')
    assert.equal(usageOp.data.targetKey, vipPubkey)
    assert.equal(usageOp.data.entityType, 'pubkey')

    // Verify it saves the document with popularityLevel 999
    const saveOp = ops.find(op => op.type === 'insertOrReplaceDocument')
    assert.equal(saveOp.data.document.popularityLevel, 999)
  })

  it('should not allow resubmission of an older addressable event if a deletion event exists', async () => {
    const pubkey = VALID_PUBKEY_DEL
    const dTag = 'resubmitted-addressable'
    const kind = 30000 // addressable

    const { eventToRecord } = await import('#models/event/mapper.js')

    // 1. Seed the Deletion Event (created_at: 2000)
    const deleteEvent = {
      id: pad64('d1'), // valid hex
      pubkey,
      kind: eventKinds.DELETION,
      tags: [['a', `${kind}:${pubkey}:${dTag}`]],
      created_at: 2000,
      content: '',
      sig: VALID_SIG
    }
    const deleteRecord = eventToRecord(deleteEvent, { receivedAt: 2000 })
    await mdb.index('events').addDocuments([{
      ...deleteRecord,
      byteSize: 100,
      ownerType: 'pubkey',
      ip: '1.2.3.4'
    }])

    // 2. Try to save an addressable event OLDER than the deletion (created_at: 1000)
    const olderEvent = {
      id: pad64('d2'), // valid hex
      pubkey,
      created_at: 1000,
      kind,
      tags: [['d', dTag]],
      content: 'I am old and deleted',
      sig: VALID_SIG
    }

    const result = await EventSaver.run({ ws: {}, event: olderEvent, ip: '1.2.3.4' })

    assert.equal(result.isSuccess, false)
    assert.equal(result.message, 'invalid: the author requested the deletion of the event you just tried to store')
  })

  it('should correctly safeguard delete by address (bound by kind, author, and d-tag)', async () => {
    const { eventToRecord } = await import('#models/event/mapper.js')
    const author1 = pad64('e1')
    const author2 = pad64('e2') // different author
    const dTagBound = 'delete_by_addr_test_bound'
    const dTagOther = 'delete_by_addr_test_bound_x'
    const kindAddressable = 30023
    const kindDraft = 30024

    // 1. Prepare 4 events
    const events = [
      { // Event 1: Target (Matches everything)
        id: pad64('101'),
        pubkey: author1,
        kind: kindAddressable,
        created_at: 1000,
        tags: [['d', dTagBound]],
        content: 'target',
        sig: VALID_SIG
      },
      { // Event 2: Different Author
        id: pad64('102'),
        pubkey: author2,
        kind: kindAddressable,
        created_at: 1000,
        tags: [['d', dTagBound]],
        content: 'diff author',
        sig: VALID_SIG
      },
      { // Event 3: Different d-tag
        id: pad64('103'),
        pubkey: author1,
        kind: kindAddressable,
        created_at: 1000,
        tags: [['d', dTagOther]],
        content: 'diff d-tag',
        sig: VALID_SIG
      },
      { // Event 4: Different Kind
        id: pad64('104'),
        pubkey: author1,
        kind: kindDraft,
        created_at: 1000,
        tags: [['d', dTagBound]],
        content: 'diff kind',
        sig: VALID_SIG
      }
    ]

    // 2. Seed events to DB
    const documents = events.map(e => ({
      ...eventToRecord(e, { receivedAt: 1000 }),
      byteSize: 100,
      ownerType: 'pubkey',
      ip: '1.2.3.4'
    }))
    await mdb.index('events').addDocuments(documents)

    // 3. Create Deletion Event targeting Event 1 specific a-tag
    // a-tag format: <kind>:<pubkey>:<d-tag>
    const aTag = `${kindAddressable}:${author1}:${dTagBound}`
    const deleteEvent = {
      id: pad64('d01'), // valid hex
      pubkey: author1,
      kind: 5,
      created_at: 1100,
      tags: [['a', aTag]],
      content: '',
      sig: VALID_SIG
    }

    // 4. Run Saver
    const result = await EventSaver.run({ ws: {}, event: deleteEvent, ip: '1.2.3.4' })
    assert.ok(result.isSuccess)

    // 5. Verify Deletions
    // We expect queueOps to contain a delete op ONLY for Event 1
    // Note: Addressable events use 'ref' (address hash) as key, not event.id
    const allOps = queueOpsMock.mock.calls.flatMap(call => call.arguments[0])
    const deleteOps = allOps.filter(op => op.type === 'deleteDocumentIfExists')
    const deletedKeys = deleteOps.map(op => op.data.key)

    // Event 1 ref should be deleted
    assert.ok(deletedKeys.includes(documents[0].ref), 'Event 1 should be deleted')

    // Event 2, 3, 4 refs should NOT be deleted
    assert.ok(!deletedKeys.includes(documents[1].ref), 'Event 2 (diff author) should NOT be deleted')
    assert.ok(!deletedKeys.includes(documents[2].ref), 'Event 3 (diff d-tag) should NOT be deleted')
    assert.ok(!deletedKeys.includes(documents[3].ref), 'Event 4 (diff kind) should NOT be deleted')
  })
})
