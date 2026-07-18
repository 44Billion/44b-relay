import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { addressToRef, idToRef } from '#models/event/mapper.js'

// Mock dependencies
const queueOpsMock = mock.fn()
const checkStorageLimitAndPruneMock = mock.fn(() => ({ popularityLevel: 1, ops: [] }))

mock.module('#services/event/maintainer/mdb/index.js', {
  namedExports: {
    queueOps: queueOpsMock,
    checkStorageLimitAndPrune: checkStorageLimitAndPruneMock
  }
})

// Import EventSaver
const { default: EventSaver } = await import('#services/event/saver/mdb/index.js')

describe('EventSaver HLL', () => {
  it('should queue mergeNip45Hll op for kind 1111 events with E tag', async () => {
    const rootId = 'a'.repeat(64)
    const event = {
      id: 'b'.repeat(64),
      pubkey: 'c'.repeat(64),
      kind: 1111,
      tags: [['E', rootId, '', 'root']],
      created_at: 1000,
      content: 'comment',
      sig: 'd'.repeat(128)
    }

    // Ensure checkStorageLimitAndPrune returns popularityLevel <= 6
    checkStorageLimitAndPruneMock.mock.mockImplementation(() => {
      return { popularityLevel: 1, ops: [] }
    })

    await EventSaver.run({ ws: {}, event, ip: '127.0.0.1' })

    // Verify op
    const calls = queueOpsMock.mock.calls
    assert.ok(calls.length > 0)

    // find call with mergeNip45Hll
    let found = false
    for (const call of calls) {
      const ops = call.arguments[0]
      if (ops) {
        const mergeOp = ops.find(op => op.type === 'mergeNip45Hll')
        if (mergeOp) {
          found = true
          assert.equal(mergeOp.data.index, 'events')
          assert.equal(mergeOp.data.key, idToRef(rootId))
          assert.equal(mergeOp.data.field, 'commentCounter')
          assert.ok(mergeOp.data.offset >= 8 && mergeOp.data.offset <= 23)
          assert.ok(mergeOp.data.hll)
        }
      }
    }
    assert.ok(found, 'Should have mergeNip45Hll op')
  })

  it('should NOT queue mergeNip45Hll op if popularityLevel > 6', async () => {
    const rootId = 'a'.repeat(64)
    const event = {
      id: 'e'.repeat(64),
      pubkey: 'c'.repeat(64),
      kind: 1111,
      tags: [['E', rootId, '', 'root']],
      created_at: 1000,
      content: 'spam comment',
      sig: 'd'.repeat(128)
    }

    // Return high popularity (spam/low quality)
    checkStorageLimitAndPruneMock.mock.mockImplementation(() => {
      return { popularityLevel: 999, ops: [] }
    })

    // Reset mocks to clear previous calls
    queueOpsMock.mock.resetCalls()

    await EventSaver.run({ ws: {}, event, ip: '127.0.0.1' })

    const calls = queueOpsMock.mock.calls

    let found = false
    for (const call of calls) {
      const ops = call.arguments[0]
      if (ops) {
        const mergeOp = ops.find(op => op.type === 'mergeNip45Hll')
        if (mergeOp) {
          found = true
        }
      }
    }
    assert.equal(found, false, 'Should NOT have mergeNip45Hll op')
  })

  it('should queue mergeNip45Hll op for kind 1 events with e tag (replyCounter)', async () => {
    const rootId = 'a'.repeat(64)
    const event = {
      id: 'b'.repeat(64),
      pubkey: 'c'.repeat(64),
      kind: 1,
      tags: [['e', rootId, '', 'root']],
      created_at: 1000,
      content: 'reply',
      sig: 'd'.repeat(128)
    }

    checkStorageLimitAndPruneMock.mock.mockImplementation(() => {
      return { popularityLevel: 1, ops: [] }
    })
    queueOpsMock.mock.resetCalls()

    await EventSaver.run({ ws: {}, event, ip: '127.0.0.1' })

    const calls = queueOpsMock.mock.calls
    let found = false
    for (const call of calls) {
      const ops = call.arguments[0]
      if (ops) {
        const mergeOp = ops.find(op => op.type === 'mergeNip45Hll')
        if (mergeOp) {
          found = true
          assert.equal(mergeOp.data.index, 'events')
          assert.equal(mergeOp.data.key, idToRef(rootId))
          assert.equal(mergeOp.data.field, 'replyCounter')
          assert.ok(mergeOp.data.offset >= 8 && mergeOp.data.offset <= 23)
          assert.ok(mergeOp.data.hll)
        }
      }
    }
    assert.ok(found, 'Should have mergeNip45Hll op')
  })

  it('should queue mergeNip45Hll op for kind 6 events with e tag (repostCounter)', async () => {
    const rootId = 'a'.repeat(64)
    const event = {
      id: 'b'.repeat(64),
      pubkey: 'c'.repeat(64),
      kind: 6,
      tags: [['e', rootId, '', 'root']],
      created_at: 1000,
      content: '',
      sig: 'd'.repeat(128)
    }

    checkStorageLimitAndPruneMock.mock.mockImplementation(() => {
      return { popularityLevel: 1, ops: [] }
    })
    queueOpsMock.mock.resetCalls()

    await EventSaver.run({ ws: {}, event, ip: '127.0.0.1' })

    const calls = queueOpsMock.mock.calls
    let found = false
    for (const call of calls) {
      const ops = call.arguments[0]
      if (ops) {
        const mergeOp = ops.find(op => op.type === 'mergeNip45Hll')
        if (mergeOp) {
          found = true
          assert.equal(mergeOp.data.index, 'events')
          assert.equal(mergeOp.data.key, idToRef(rootId))
          assert.equal(mergeOp.data.field, 'repostCounter')
          assert.ok(mergeOp.data.offset >= 8 && mergeOp.data.offset <= 23)
          assert.ok(mergeOp.data.hll)
        }
      }
    }
    assert.ok(found, 'Should have mergeNip45Hll op')
  })

  it('should queue mergeNip45Hll op for kind 1 events with q tag (quoteCounter)', async () => {
    const rootId = 'a'.repeat(64)
    const event = {
      id: 'b'.repeat(64),
      pubkey: 'c'.repeat(64),
      kind: 1,
      tags: [['q', rootId, '', 'root']],
      created_at: 1000,
      content: 'quote',
      sig: 'd'.repeat(128)
    }

    checkStorageLimitAndPruneMock.mock.mockImplementation(() => {
      return { popularityLevel: 1, ops: [] }
    })
    queueOpsMock.mock.resetCalls()

    await EventSaver.run({ ws: {}, event, ip: '127.0.0.1' })

    const calls = queueOpsMock.mock.calls
    let found = false
    for (const call of calls) {
      const ops = call.arguments[0]
      if (ops) {
        const mergeOp = ops.find(op => op.type === 'mergeNip45Hll')
        if (mergeOp) {
          found = true
          assert.equal(mergeOp.data.index, 'events')
          assert.equal(mergeOp.data.key, idToRef(rootId))
          assert.equal(mergeOp.data.field, 'quoteCounter')
          assert.ok(mergeOp.data.offset >= 8 && mergeOp.data.offset <= 23)
          assert.ok(mergeOp.data.hll)
        }
      }
    }
    assert.ok(found, 'Should have mergeNip45Hll op')
  })

  it('should ignore malformed q targets without logging an HLL processing error', async t => {
    const consoleErrorMock = t.mock.method(console, 'error', () => {})
    checkStorageLimitAndPruneMock.mock.mockImplementation(() => {
      return { popularityLevel: 1, ops: [] }
    })

    const malformedTargets = [
      'abc', // odd length: the production regression
      'a'.repeat(62),
      'a'.repeat(66),
      '0g'.repeat(32)
    ]
    for (const [index, target] of malformedTargets.entries()) {
      queueOpsMock.mock.resetCalls()
      const event = {
        id: `${'b'.repeat(63)}${index}`,
        pubkey: 'c'.repeat(64),
        kind: 1,
        tags: [['q', target]],
        created_at: 1000,
        content: 'quote with malformed target',
        sig: 'd'.repeat(128)
      }

      const result = await EventSaver.run({ ws: {}, event, ip: '127.0.0.1' })

      assert.equal(result.isSuccess, true)
      const queuedOps = queueOpsMock.mock.calls.flatMap(call => call.arguments[0] ?? [])
      assert.ok(queuedOps.some(op => op.type === 'insertOrReplaceDocument'))
      assert.equal(
        queuedOps.some(op => op.type === 'mergeNip45Hll' && op.data.field === 'quoteCounter'),
        false
      )
    }
    assert.equal(consoleErrorMock.mock.callCount(), 0)
  })

  it('should fall back from a malformed E target to a valid A target', async t => {
    const consoleErrorMock = t.mock.method(console, 'error', () => {})
    const rootAddress = `30023:${'a'.repeat(64)}:article`
    const event = {
      id: 'b'.repeat(64),
      pubkey: 'c'.repeat(64),
      kind: 1111,
      tags: [['E', 'abc'], ['A', rootAddress]],
      created_at: 1000,
      content: 'comment',
      sig: 'd'.repeat(128)
    }

    checkStorageLimitAndPruneMock.mock.mockImplementation(() => {
      return { popularityLevel: 1, ops: [] }
    })
    queueOpsMock.mock.resetCalls()

    const result = await EventSaver.run({ ws: {}, event, ip: '127.0.0.1' })

    assert.equal(result.isSuccess, true)
    const queuedOps = queueOpsMock.mock.calls.flatMap(call => call.arguments[0] ?? [])
    const mergeOp = queuedOps.find(op => op.type === 'mergeNip45Hll')
    assert.equal(mergeOp?.data.key, addressToRef({ address: rootAddress }))
    assert.equal(mergeOp?.data.field, 'commentCounter')
    assert.equal(consoleErrorMock.mock.callCount(), 0)
  })
})
