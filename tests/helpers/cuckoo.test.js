import { describe, it } from 'node:test'
import assert from 'node:assert'
import { CuckooFilter, packFilter, unpackFilter } from '../../helpers/cuckoo.js'

describe('Cuckoo Filter Helper', () => {
  it('should pack and unpack a CuckooFilter correctly', async () => {
    const filter = new CuckooFilter(200, 4, 2)
    filter.add('item1')
    filter.add('item2')
    filter.add('item3')

    const packed = await packFilter(filter)
    assert.ok(typeof packed === 'string')
    assert.ok(packed.length > 0)

    const unpacked = await unpackFilter(packed)
    assert.ok(unpacked instanceof CuckooFilter)
    assert.equal(unpacked.has('item1'), true)
    assert.equal(unpacked.has('item2'), true)
    assert.equal(unpacked.has('item3'), true)
    assert.equal(unpacked.has('item4'), false)
  })

  it('should handle large filters efficiently', async () => {
    const size = 10000
    const filter = new CuckooFilter(size, 4, 2)
    const items = []
    for (let i = 0; i < 1000; i++) {
      const item = `large-test-${i}`
      filter.add(item)
      items.push(item)
    }

    const packed = await packFilter(filter)
    // Basic sanity check on size - raw JSON is huge, binary+zstd should be smaller
    // Exact size depends on randomness, but we expect it to be reasonable.
    assert.ok(packed.length > 0)

    const unpacked = await unpackFilter(packed)
    for (const item of items) {
      assert.equal(unpacked.has(item), true)
    }
  })

  it('should return null for null input', async () => {
    assert.equal(await packFilter(null), null)
    assert.equal(await unpackFilter(null), null)
  })

  it('should fallback to legacy JSON parsing if unpack fails as binary', async () => {
    // Create a legacy JSON string (simulating old data)
    const filter = new CuckooFilter(10, 4, 2)
    filter.add('legacy-item')
    const jsonStr = JSON.stringify(filter.saveAsJSON())

    // We pass it directly (unpackFilter expects base64 of compressed usually,
    // but the fallback logic catches "Try plain JSON parse")

    // However, unpackFilter tries `buffer = Buffer.from(str, 'base64')` first.
    // `decompressAsync(buf)` will fail if it's not zstd.
    // So it goes to catch block.
    // Then it tries JSON.parse(str).

    const unpacked = await unpackFilter(jsonStr)
    assert.ok(unpacked instanceof CuckooFilter)
    assert.equal(unpacked.has('legacy-item'), true)
  })

  it('should monkey-patch toBuffer and fromBuffer', () => {
    const filter = new CuckooFilter(50, 4, 2)
    filter.add('test')

    assert.ok(typeof filter.toBuffer === 'function')

    const buf = filter.toBuffer()
    assert.ok(Buffer.isBuffer(buf))

    const restored = CuckooFilter.fromBuffer(buf)
    assert.equal(restored.has('test'), true)
    assert.equal(restored._capacity, filter._capacity)
  })
})
