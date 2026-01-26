import { describe, it } from 'node:test'
import assert from 'node:assert'
import { FastBloomFilter, packFilter, unpackFilter } from '../../helpers/bloom.js'

describe('Bloom Filter Helper', () => {
  it('should pack and unpack a BloomFilter correctly', async () => {
    // 0.0001 => 0.01 false positive rate
    // 0.01 => 1% false positive rate
    const filter = await FastBloomFilter.createOptimal(200, 0.01)
    filter.add(Buffer.from('item1'))
    filter.add(Buffer.from('item2'))
    filter.add(Buffer.from('item3'))

    const packed = await packFilter(filter)
    assert.ok(typeof packed === 'string')
    assert.ok(packed.length > 0)

    const unpacked = await unpackFilter(packed)
    assert.equal(unpacked.has(Buffer.from('item1')), true)
    assert.equal(unpacked.has(Buffer.from('item2')), true)
    assert.equal(unpacked.has(Buffer.from('item3')), true)
    assert.equal(unpacked.has(Buffer.from('item4')), false)
  })

  it('should handle large filters efficiently', async () => {
    const size = 10000
    const filter = await FastBloomFilter.createOptimal(size, 0.01)
    const items = []
    for (let i = 0; i < 1000; i++) {
      const item = `large-test-${i}`
      filter.add(Buffer.from(item))
      items.push(item)
    }

    const packed = await packFilter(filter)
    assert.ok(packed.length > 0)

    const unpacked = await unpackFilter(packed)
    for (const item of items) {
      assert.equal(unpacked.has(Buffer.from(item)), true)
    }
  })

  it('should return null for null input', async () => {
    assert.equal(await packFilter(null), null)
    assert.equal(await unpackFilter(null), null)
  })
})
