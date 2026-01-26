import FastBloomFilter from 'fast-bloom-filter'
import { serialize, deserialize } from 'node:v8'
import { compressAsync, decompressAsync } from './buffer.js'

/**
 * Packs a BloomFilter into a Base64-encoded compressed format using Zstd.
 * @param {FastBloomFilter} filter
 * @returns {Promise<string|null>}
 */
export async function packFilter (filter) {
  if (!filter) return null
  try {
    const exported = filter.export()
    // Use V8 serialize to preserve types (like TypedArrays) if any
    const buf = serialize(exported)
    const compressed = await compressAsync(buf)
    return compressed.toString('base64url')
  } catch (err) {
    console.warn('Failed to pack bloom filter', err)
    return null
  }
}

/**
 * Unpacks a BloomFilter from a Base64 string.
 * @param {string} str
 * @returns {Promise<FastBloomFilter|null>}
 */
export async function unpackFilter (str) {
  if (!str) return null
  try {
    const buf = Buffer.from(str, 'base64url')
    const inflated = await decompressAsync(buf)

    // Use V8 deserialize
    const snapshot = deserialize(inflated)

    return await FastBloomFilter.import(snapshot)
  } catch (err) {
    console.warn('Failed to unpack bloom filter', err)
    return null
  }
}

export { FastBloomFilter }
