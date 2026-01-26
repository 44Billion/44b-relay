// Nucleus Sampling or Top-P (Top-P is used in LLMs for token sampling)
//
// This keeps a list of candidates like a top-k algorithm if you don't have one available.
// If you have one, you don't need the Count-Min Sketch (CMS) part.
//
// In a streaming environment, the Candidates list is usually
// a min-heap or a fixed-size Map that acts as a "waiting room" for high-frequency items.
// You update the Count-Min Sketch (CMS) for every single item,
// but you only allow an item into the Candidates list if its estimated
// frequency is high enough to potentially be a "Heavy Hitter."
//
// No matter how many millions of users request different items,
// your candidates list stays at 1,000 (or whatever you set),
// and your CMS stays at a fixed size based on your error tolerance.
//
// Dynamic Nucleus: If user behavior changes and 50% of requests are now concentrated
// in just 3 items, your getTopPMass(0.5) will return 3 items. If the requests spread
// out and 50% of the mass requires 800 items, it will return 800 items.
//
// The "Safety Valve": If user behavior is so chaotic that 50% of the mass would require
// 50,000 items (more than your 1,000 capacity), the reachedTarget flag will be false.
// This tells you that the "Top-P" is currently too large to be considered a "Heavy Hitter" group.
//
// The candidates logic is usually handled in the application layer (the "Heavy Hitter" wrapper)
// because the Sketch itself doesn't remember which items were inserted, only their counts.
//
// TODO:
// - Min-Heap for Candidates for O(1) access to minimum
// - Serialize/deserialize to Uint8Array -> ztsd compress -> base64 to store in MDB
// - Merge function to combine two TopP instances (local from processes and global from MDB)
// - Tests

import { ConservativeCountMin as CountMinSketch } from 'sketch-oxide-node'
import { HyperLogLog } from 'nostr-hll/hyperloglog.js'

// Nucleus Tracker
export default class TopP {
  constructor (capacity = 1000 /* k; number of candidates (The top k, but not using TopK algo) to track */) {
    this.cms = new CountMinSketch(/* ... */) // Count each item's frequency
    this.hll = new HyperLogLog(/* ... */)    // To track total unique/volume

    this.maxCandidates = capacity
    this.candidates = new Map() // Stores { item: current_estimate }
    this.totalCount = 0
  }

  observe (item) {
    this.totalCount++

    // 1. Always update the Sketch (the "Source of Truth" for frequency)
    this.cms.increment(item)
    const currentEstimate = this.cms.query(item)

    // 2. Manage the Candidate Pool
    if (this.candidates.has(item)) {
      // If already a candidate, update its known frequency
      this.candidates.set(item, currentEstimate)
    } else if (this.candidates.size < this.maxCandidates) {
      // If pool isn't full, just add it
      this.candidates.set(item, currentEstimate)
    } else {
      // If pool is full, check if this item is "heavier" than the lightest candidate
      // Optimization: In production, use a Min-Heap for O(1) access to the minimum
      const minEntry = this.getMinCandidate()

      if (currentEstimate > minEntry.count) {
        this.candidates.delete(minEntry.item)
        this.candidates.set(item, currentEstimate)
      }
    }
  }

  getMinCandidate () {
    let minItem = null
    let minCount = Infinity
    for (const [item, count] of this.candidates) {
      if (count < minCount) {
        minCount = count
        minItem = item
      }
    }
    return { item: minItem, count: minCount }
  }

  // This is your "Top-P" query
  // topp meaning the smallest number of items whose combined
  // frequency (or probability if talking about LLM tokens)
  // is e.g. 50% (if p=0.5)
  // e.g. the 50% most frequently requested items
  getTopPMass (p = 0.5) {
    const target = this.totalCount * p

    // Sort candidates by the most recent estimate from CMS
    const sorted = [...this.candidates.entries()]
      .sort((a, b) => b[1] - a[1])

    let sum = 0
    const result = []

    for (const [item, count] of sorted) {
      sum += count
      result.push({ item, count })
      if (sum >= target) break
    }

    return {
      items: result,
      reachedTarget: sum >= target,
      massCovered: sum / this.totalCount
    }
  }
}
