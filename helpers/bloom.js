import FastBloomFilter from 'fast-bloom-filter'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { serialize, deserialize } from 'node:v8'

const compressAsync = async (buf) => {
  const compressor = createZstdCompress({ level: 3 })
  const source = Readable.from(buf)
  source.pipe(compressor)
  return buffer(compressor)
}

const decompressAsync = async (buf) => {
  const decompressor = createZstdDecompress()
  const source = Readable.from(buf)
  source.pipe(decompressor)
  return buffer(decompressor)
}

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
    return compressed.toString('base64')
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
    const buf = Buffer.from(str, 'base64')
    const inflated = await decompressAsync(buf)

    // Use V8 deserialize
    const snapshot = deserialize(inflated)

    return await FastBloomFilter.import(snapshot)
  } catch (_err) {
    // console.warn('Failed to unpack bloom filter', _err)
    return null
  }
}

export { FastBloomFilter }
