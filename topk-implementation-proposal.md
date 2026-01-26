# Implementation Proposal: Transition from Map<HLL> to TopK (Sketch)

## Context

Currently, the `requested-pubkeys.js` service maintains an in-memory `Map` where every requested Pubkey maps to a `HyperLogLog` (HLL) structure. This implementation is designed to calculate the **cardinality** (number of unique IPs) of requests for each pubkey to determine "popularity".

## The Problem

- **Unbounded Growth:** The Map grows linearly with the number of unique Pubkeys requested. If 1,000,000 unique pubkeys are requested in a window, we instantiate and store 1,000,000 HLL objects.
- **DB Cost:** Persisting this data requires either maintaining 1,000,000 documents in MeiliSearch or serializing a massive Blob. Writing these updates is I/O intensive.
- **Inefficiency:** We practically only utilize the data for the "Top N" (e.g., Top 1000) - not really - popular pubkeys to cache their events. We are paying a storage and processing penalty for the "Long Tail" of millions of pubkeys that are rarely requested.

## The Solution: TopK Sketch

Transition to using the **TopK** algorithm (some options are available in `sketch-oxide-node`). The TopK sketch is a probabilistic data structure (often based on SpaceSaving or similar algorithms) designed specifically to track the "Heavy Hitters" in a stream using **fixed memory**.

However there's currently no specific implementation in the library selected because although the Node.js bindings currently support **Merging**, the **Serialization** is absent or misses the inclusion of the added items.

We could instead use an easier to serialize algo such as [Misra–Gries heavy hitters algorithm](https://en.wikipedia.org/wiki/Misra%E2%80%93Gries_heavy_hitters_algorithm#Misra%E2%80%93Gries_algorithm).

### Comparison Table

| Feature | Current Approach (Map of HLLs) | Proposed Approach (TopK) |
| :--- | :--- | :--- |
| **Metric** | **Unique IPs** (Cardinality) | **Total Requests** (Frequency)* |
| **Memory Usage** | Linear $O(N)$ (Unbounded) | Constant $O(k)$ (Fixed) |
| **DB Storage Cost** | High (Huge linear dataset) | Low (Single fixed-size binary blob) |
| **Read Performance** | Slow (Scan huge index/map) | Instant (Query internal heap) |
| **Write Performance** | Heavy (Flush many keys) | Light (Flush 1 blob) |
| **Mergeability** | Yes (HLL Union) | Yes (TopK Merge) |

*\* Note: Switching to Topk implies changing the metric from "Distinct IPs" to "Total Hits". While we lose the Sybil-resistance of counting unique IPs, we can mitigate this by pre-filtering spam IPs using the existing `ip-activity` tracker before updating the sketch: `if (getIpScore(ip) > SPAM_SCORE_THRESHOLD) return`.*

## Implementation Plan

### 1. Service Layer (`requested-pubkeys.js`)
*   **Dependency:** Swap `nostr-hll` for `sketch-oxide-node`'s `TopK` but maintain usage of `HyperLogLog` (either from `nostr-hll` or `sketch-oxide`).
*   **State:**
    * Replace `const requestedPubkeysCache = new Map()` with `let localSketch = new TopK(buckets, depth)`.
    * Add `let pubkeyCounter = new HyperLogLog(errorRate)` to track the total distinct pubkeys seen (for percentile calculations).
*   **Tracking:**
    *   Current: `get(pubkey).add(ip)`
    *   Proposed:
        1. `localSketch.update(Buffer.from(pubkey), 1)` (Increment count).
        2. `pubkeyCounter.update(Buffer.from(pubkey))` (Track global distinct count).
    *   *Constraint:* Ensure `trackRequestedPubkeys` is called *after* IP spam checks to prevent a single IP from bloating the frequency count.

### 2. Persistence Layer (`process-pending-ops`)
*   **Operation:** Introduce `opType === 'mergeTopK'`, similar to the existing `mergeSketch` used for IP activity.
*   **Logic:**
    1. Load `globalTopK` and `globalPubkeyCounter` from DB (Two Documents).
    2. Deserialize `localSketch` (TopK) and `pubkeyCounter` from the operation payload.
    3. Perform `globalTopK.merge(localSketch)` and `globalPubkeyCounter.merge(pubkeyCounter)`.
    4. Save both back to DB (serialize to buffer -> base64).

### 3. Analytics Job (`calc-popular-pubkeys.js`)
*   **Current:** Iterates over a MeiliSearch index of pubkeys, potentially needing to fetch all to sort (no, we fetch them already sorted with count:desc because we have a count field besides the hll one).
*   **Proposed:**
    1. Fetch the single `TopK` blob and the `HLL` blob.
    2. Call `const cardinality = globalPubkeyCounter.estimate()` to get the total number of distinct pubkeys seen.
    3. Calculate tier thresholds (e.g., Top 1% = cardinality * 0.01).
    4. Call `globalTopK.heavyHitters(threshold)` to get the sorted list of heavy hitters immediately.
    5. Iterate this small list, assign tiers using the calculated thresholds, and populate the `popularPubkeys` collection.

## Why execute this transition?

1.  **Scalability:** The memory footprint becomes deterministic. We can handle 100M events without crashing the process or the DB.
2.  **Cost Efficiency:** Reduces MeiliSearch costs (fewer units/storage) significantly by collapsing millions of potential keys into one document.
3.  **Simplicity:** The logic for "Finding Top K" is inherent to the data structure, removing the need for sorting logic in the application code.

## Drawbacks

1. Topk won't help with setting the rank for up to 50% of the pubkeys as we do today, which we use for broad filter responses. It would only assign ranks to the top x% pubkeys up until the top k max fixed number of pubkeys set (the k variable when instantiating the data structure), so x varies.
We could use our custom TopP instead, which combines Count-Min Sketch with HLL and would allow us to
atleast rank pubkeys outside of the "Candidates" (effectively the topk). See top-k.js or top-p.js services.

2. Both TopK and TopP would have lower sybil-resistance.
