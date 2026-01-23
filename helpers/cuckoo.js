// helpers/cuckoo.js
import bloomFilters from 'bloom-filters'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'

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

const { CuckooFilter } = bloomFilters

// --- Monkey-patch CuckooFilter for efficient Binary Serialization ---
// Structure:
// [Version:1][Capacity:4][FPLength:1][BucketSize:1][Length:4][Seed:8 (Double)][...Buckets...]
// Buckets: [Count:1][FPBytes...]

if (!CuckooFilter.prototype.toBuffer) {
  CuckooFilter.prototype.toBuffer = function () {
    const bucketCount = this._filter.length
    const fpBytes = Math.ceil(this._fingerprintLength / 2)

    // Estimate size: Header(19) + Buckets(bucketCount * 1) + Values(length * fpBytes)
    const size = 19 + bucketCount + (this._length * fpBytes) + 1024
    const buf = Buffer.allocUnsafe(size)

    let offset = 0
    buf.writeUInt8(1, offset++) // Version
    buf.writeUInt32BE(bucketCount, offset); offset += 4 // Capacity (Number of Buckets)
    buf.writeUInt8(this._fingerprintLength, offset++)
    buf.writeUInt8(this._bucketSize, offset++)
    buf.writeUInt32BE(this._length, offset); offset += 4
    buf.writeDoubleBE(this._seed, offset); offset += 8

    for (let i = 0; i < bucketCount; i++) {
      const bucket = this._filter[i]
      const count = bucket.length
      buf.writeUInt8(count, offset++)

      const elements = bucket._elements
      for (let j = 0; j < elements.length; j++) {
        let fp = elements[j]
        if (fp !== null && fp !== undefined) {
          if (typeof fp !== 'string') {
            if (typeof fp === 'number') {
              fp = fp.toString(16)
              if (fp.length % 2 !== 0) fp = '0' + fp // Left pad numbers
            } else {
              fp = String(fp)
            }
          }

          // Pad right if odd length (e.g. 'abc' -> 'abc0') so it fits valid byte boundaries
          if (fp.length % 2 !== 0) fp += '0'

          buf.write(fp, offset, fpBytes, 'hex')
          offset += fpBytes
        }
      }
    }

    return buf.subarray(0, offset)
  }
}

if (!CuckooFilter.fromBuffer) {
  CuckooFilter.fromBuffer = function (buf) {
    let offset = 0
    const version = buf.readUInt8(offset++)
    if (version !== 1) throw new Error('Unknown CuckooFilter buffer version')

    const size = buf.readUInt32BE(offset); offset += 4
    const fingerprintLength = buf.readUInt8(offset++)
    const bucketSize = buf.readUInt8(offset++)
    const length = buf.readUInt32BE(offset); offset += 4
    const seed = buf.readDoubleBE(offset); offset += 8

    const filter = new CuckooFilter(size, fingerprintLength, bucketSize)
    filter._seed = seed
    filter._length = length

    // Hack to get the Bucket constructor from a fresh filter instance
    const tempFilter = new CuckooFilter(1, 4, bucketSize)
    const Bucket = tempFilter._filter[0].constructor

    // Reconstruct buckets
    const newFilterArray = new Array(size)
    const fpBytes = Math.ceil(fingerprintLength / 2)

    for (let i = 0; i < size; i++) {
      const count = buf.readUInt8(offset++)
      const bucket = new Bucket(bucketSize)
      // bucket has _length=0, _elements=[null...]

      for (let j = 0; j < count; j++) {
        const fpHex = buf.toString('hex', offset, offset + fpBytes)
        // Trim padding if original length was odd
        const fp = fpHex.substring(0, fingerprintLength)

        // bucket.add finds next empty slot
        bucket.add(fp)
        offset += fpBytes
      }
      newFilterArray[i] = bucket
    }

    filter._filter = newFilterArray
    return filter
  }
}

/**
 * Packs a CuckooFilter into a Base64-encoded specialized binary compressed format using Zstd.
 * @param {CuckooFilter} filter
 * @returns {Promise<string|null>}
 */
export async function packFilter (filter) {
  if (!filter) return null
  try {
    const bin = filter.toBuffer()
    const compressed = await compressAsync(bin)
    return compressed.toString('base64')
  } catch (err) {
    console.warn('Failed to pack filter efficiently, falling back to JSON', err)
    const jsonBuf = Buffer.from(JSON.stringify(filter.saveAsJSON()))
    const compressed = await compressAsync(jsonBuf)
    return compressed.toString('base64')
  }
}

/**
 * Unpacks a CuckooFilter from a Base64 string (supports binary-compressed and legacy JSON).
 * @param {string} str
 * @returns {Promise<CuckooFilter|null>}
 */
export async function unpackFilter (str) {
  if (!str) return null
  try {
    const buf = Buffer.from(str, 'base64')
    const inflated = await decompressAsync(buf)

    // Check header for JSON vs Binary
    if (inflated[0] === 0x7B) { // '{'
      return CuckooFilter.fromJSON(JSON.parse(inflated.toString()))
    } else {
      return CuckooFilter.fromBuffer(inflated)
    }
  } catch (_err) {
    try {
      return CuckooFilter.fromJSON(JSON.parse(str))
    } catch (e) {
      console.warn('Failed to unpack cuckoo filter, returning null.', e)
      return null
    }
  }
}

export { CuckooFilter }
