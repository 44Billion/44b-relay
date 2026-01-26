// Top-k/heavy-hitters implementation for frequency estimation
// (most k frequently occurring items in a data stream)
//
// Misra-Gries heavy hitters (vanilla JavaScript)
// - Stores original string items
// - Weighted updates (add method increments item x - weight - times at once)
// - Mergeable
// - Serialize / deserialize to compact Uint8Array (LEB128 varints + UTF-8)
// - Constructor accepts k (number of heavy hitters to keep)
//
// - Drawback: No decay factor. store 2 TopKs (MisraGries) data structure instances,
//   a previous and a current one (Sliding Window)
//
// TODO: Review and add Tests

const MAGIC = 0x4d47 // 'MG'
const VERSION = 1

// Simple byte writer using an array of numbers
class ByteWriter {
  constructor () {
    this.buf = []
  }

  writeByte (b) {
    this.buf.push(b & 0xff)
  }

  writeBytes (bytes) {
    for (let i = 0; i < bytes.length; i++) this.buf.push(bytes[i])
  }

  // write unsigned LEB128
  writeVarUint (n) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('varuint: number out of range')
    while (n >= 0x80) {
      this.writeByte((n & 0x7f) | 0x80)
      n = Math.floor(n / 128)
    }
    this.writeByte(n & 0x7f)
  }

  toUint8Array () {
    return new Uint8Array(this.buf)
  }
}

class ByteReader {
  constructor (buf) {
    this.view = buf
    this.pos = 0
  }

  readByte () {
    if (this.pos >= this.view.length) throw new Error('Unexpected EOF')
    return this.view[this.pos++]
  }

  readBytes (n) {
    if (this.pos + n > this.view.length) throw new Error('Unexpected EOF')
    const slice = this.view.subarray(this.pos, this.pos + n)
    this.pos += n
    return slice
  }

  // read unsigned LEB128
  readVarUint () {
    let shift = 0
    let result = 0
    while (true) {
      const b = this.readByte()
      // NOTE: use arithmetic accumulation to avoid bitwise-int32 issues
      result += (b & 0x7f) * Math.pow(2, shift)
      if ((b & 0x80) === 0) break
      shift += 7
      if (shift > 53) throw new Error('varuint too large')
    }
    return result
  }

  eof () {
    return this.pos >= this.view.length
  }
}

// Misra-Gries Heavy Hitters
export default class TopK {
  // constructor(k: number)
  // k: integer > 0
  constructor (k) {
    if (!Number.isInteger(k) || k <= 0) throw new Error('k must be positive integer')
    this.capacity = k
    this.counters = new Map() // Map<string, number>
    this.totalWeight = 0 // integer
  }

  // add(item: string, weight: number = 1) : void
  // item: string, weight: non-negative integer (>=0)
  add (item, weight) {
    if (weight === 0) return
    if (!Number.isSafeInteger(weight) || weight < 0) throw new Error('weight (how many times) must be non-negative safe integer')
    this.totalWeight += weight
    const cur = this.counters.get(item)
    if (cur !== undefined) {
      this.counters.set(item, cur + weight)
      return
    }
    if (this.counters.size < this.capacity) {
      this.counters.set(item, weight)
      return
    }
    // Weighted decrement by weight
    const itemsToDelete = []
    for (const [k, v] of this.counters) {
      const nv = v - weight
      if (nv <= 0) itemsToDelete.push(k)
      else this.counters.set(k, nv)
    }
    for (const d of itemsToDelete) this.counters.delete(d)
  }

  // estimate(item: string) : number
  // returns estimated count for the item (0 if not present)
  estimate (item) {
    return this.counters.get(item) ?? 0
  }

  // topK(k?: number) : Array<{ item: string, estimate: number }>
  // returns up to k entries sorted by estimate desc. If k omitted, uses capacity.
  topK (k) {
    const take = k ?? this.capacity
    const arr = []
    for (const [item, est] of this.counters) arr.push({ item, estimate: est })
    arr.sort((a, b) => b.estimate - a.estimate)
    return arr.slice(0, take)
  }

  // size() : number
  // returns number of stored counters
  size () {
    return this.counters.size
  }

  // clear() : void
  // clear counters and reset totalWeight
  clear () {
    this.counters.clear()
    this.totalWeight = 0
  }

  // mergeInPlace(other: TopK) : void
  // Merge another TopK into this one (mutates this). Other must be a TopK.
  mergeInPlace (other) {
    if (!(other instanceof TopK)) throw new Error('Can only merge another TopK')
    this.totalWeight += other.totalWeight
    for (const [item, cnt] of other.counters) {
      const cur = this.counters.get(item)
      if (cur !== undefined) {
        this.counters.set(item, cur + cnt)
        continue
      }
      if (this.counters.size < this.capacity) {
        this.counters.set(item, cnt)
        continue
      }
      const itemsToDelete = []
      for (const [k, v] of this.counters) {
        const nv = v - cnt
        if (nv <= 0) itemsToDelete.push(k)
        else this.counters.set(k, nv)
      }
      for (const d of itemsToDelete) this.counters.delete(d)
    }
  }

  // merged(other: TopK) : TopK
  // returns a new TopK which is the merge of this and other (does not mutate inputs)
  merged (other) {
    const copy = this.clone()
    copy.mergeInPlace(other)
    return copy
  }

  // clone() : TopK
  // returns a shallow clone of the sketch
  clone () {
    const out = new TopK(this.capacity)
    out.totalWeight = this.totalWeight
    for (const [k, v] of this.counters) out.counters.set(k, v)
    return out
  }

  // serialize() : Uint8Array
  // Compact binary serialization:
  // [MAGIC: 2 bytes BE][VERSION: 1 byte]
  // [capacity: varuint][totalWeight: varuint][numEntries: varuint]
  // for each entry: [itemLen: varuint][item bytes UTF-8][count: varuint]
  serialize () {
    const enc = new TextEncoder()
    const w = new ByteWriter()
    w.writeByte((MAGIC >> 8) & 0xff)
    w.writeByte(MAGIC & 0xff)
    w.writeByte(VERSION & 0xff)
    w.writeVarUint(this.capacity)
    w.writeVarUint(Math.floor(this.totalWeight))
    w.writeVarUint(this.counters.size)
    for (const [item, cnt] of this.counters) {
      const itemBytes = enc.encode(item)
      w.writeVarUint(itemBytes.length)
      w.writeBytes(itemBytes)
      w.writeVarUint(Math.floor(cnt))
    }
    return w.toUint8Array()
  }

  // static deserialize(buf: Uint8Array) : TopK
  static deserialize (buf) {
    const r = new ByteReader(buf)
    const b0 = r.readByte()
    const b1 = r.readByte()
    const magic = (b0 << 8) | b1
    if (magic !== MAGIC) throw new Error('Not a TopK serialization (magic mismatch)')
    const ver = r.readByte()
    if (ver !== VERSION) throw new Error('Unsupported version ' + ver)
    const capacity = r.readVarUint()
    const totalWeight = r.readVarUint()
    const numEntries = r.readVarUint()
    const dec = new TextDecoder()
    const mg = new TopK(capacity)
    mg.totalWeight = totalWeight
    for (let i = 0; i < numEntries; i++) {
      const itemLen = r.readVarUint()
      const itemBytes = r.readBytes(itemLen)
      const item = dec.decode(itemBytes)
      const cnt = r.readVarUint()
      mg.counters.set(item, cnt)
    }
    return mg
  }

  // toJSON() : object
  // export to a JSON-friendly object (not compact)
  toJSON () {
    return {
      capacity: this.capacity,
      totalWeight: this.totalWeight,
      entries: Array.from(this.counters.entries())
    }
  }

  // static fromJSON(obj: any) : TopK
  // create from object produced by toJSON
  static fromJSON (obj) {
    if (!obj || typeof obj.capacity !== 'number') throw new Error('invalid JSON')
    const mg = new TopK(obj.capacity)
    mg.totalWeight = obj.totalWeight ?? 0
    if (Array.isArray(obj.entries)) {
      for (const pair of obj.entries) {
        const k = String(pair[0])
        const v = Number(pair[1])
        mg.counters.set(k, v)
      }
    }
    return mg
  }

  // entries() : Array<[string, number]>
  // returns raw entries for debugging/testing
  entries () {
    return Array.from(this.counters.entries())
  }
}
