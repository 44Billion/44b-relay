# Hashtag Stats

MeiliSearch index for tracking hashtag co-occurrence statistics used by the topic detection system.

## Purpose

This index stores **per-hashtag statistical documents** scoped by language. It records how frequently each hashtag appears and which other hashtags co-occur, enabling the topic detector to expand and infer topics for Nostr events without relying on an LLM.

## Document structure

Each document represents one hashtag observed in a specific language:

| Field | Type | Description |
|-------|------|-------------|
| `key` | `string` | Primary key: `<lang>:<tag>`, e.g. `en:bitcoin` |
| `docType` | `string` | Always `"tag"` (kept for forward-compatible filtering) |
| `lang` | `string` | ISO 639-1 language code (e.g. `en`, `pt`, `es`) |
| `tag` | `string` | Normalized hashtag (lowercase, no `#` prefix) |
| `words` | `string[]` | Tag split into words (e.g. `["ash", "ketchum"]` for `ashketchum`) |
| `acronym` | `string\|null` | Derived acronym from words (e.g. `"ak"` for `["ash", "ketchum"]`), or `null` |
| `count` | `number` | Decayable occurrence count — how many events had this hashtag |
| `neighbors` | `[string, number][]` | Top-48 co-occurring tags sorted by count desc. Each entry is `[neighborTag, coOccurrenceCount]` |
| `updatedAt` | `number` | Timestamp in ms of last update |

### Example document

```json
{
  "key": "en:ashketchum",
  "docType": "tag",
  "lang": "en",
  "tag": "ashketchum",
  "words": ["ash", "ketchum"],
  "acronym": "ak",
  "count": 150,
  "neighbors": [
    ["pokemon", 120],
    ["anime", 90],
    ["pikachu", 60]
  ],
  "updatedAt": 1709848800000
}
```

## Data flow

```
Nostr Event
    │
    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  EventSaver (services/event/saver/mdb/index.js)                     │
│                                                                      │
│  1. extractHashtags(event) → raw hashtags from event t-tags          │
│  2. detectTopics({ hashtags, text, language }) → expanded topics     │
│     (written to event document's 'topics' field)                     │
│  3. trackHashtagStats({ hashtags, language })                        │
│     ↑ receives ONLY raw hashtags, NOT expanded topics                │
│     (expanded/inferred topics never inflate counts)                  │
└──────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  In-memory accumulator (services/event/tracker/mdb/hashtag-stats.js) │
│                                                                      │
│  • Per-language Map of tag → { count, neighbors, words, acronym }   │
│  • Pairwise co-occurrence: for each pair of hashtags on the same     │
│    event, both directions get incremented                            │
│  • Capped at 8 tags per event to prevent spam inflation              │
└──────────────────────────────────────────────────────────────────────┘
    │ (flushed every 60s by flush-hashtag-stats job)
    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Pending ops queue → process-pending-ops (mergeHashtagStats)         │
│                                                                      │
│  • Merges count deltas into existing MeiliSearch documents           │
│  • Merges neighbor co-occurrence deltas                              │
│  • Keeps only top-48 neighbors (sorted by count desc)               │
│  • Creates new docs if tag unseen in this language                  │
└──────────────────────────────────────────────────────────────────────┘
    │
    ▼
  hashtagStats MeiliSearch index
    │
    │ (read every ~10 min by topic detector cache refresh)
    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Topic Detector cache (services/topic/detector.js)                   │
│                                                                      │
│  • Loads top-500 tags per language sorted by count desc              │
│  • Builds byTag, byWord, byAcronym lookup maps                     │
│  • Used synchronously during detectTopics() — no DB reads on hot    │
│    path                                                              │
└──────────────────────────────────────────────────────────────────────┘
```

## Important design decisions

### Only raw hashtags are tracked, not expanded topics

When an event has `#ashketchum` and the topic detector expands it to also include `#pokemon` and `#anime`, **only `#ashketchum` is counted** in the stats. The expanded/inferred topics are written to the event's `topics` field but never fed back into the statistics accumulator. This prevents count inflation where all related hashtags would converge to similar counts over time.

This separation is enforced at the call site:
- `detectTopics()` returns the expanded topics (for the event record)
- `trackHashtagStats()` receives only `extractHashtags(event)` output

### Neighbor co-occurrence is directional

Each tag's `neighbors` array records how often **other tags appeared on events that had this tag**. The ratio `neighborCount / count` is directional:

- `ashketchum` (count: 100) → neighbor `pokemon` (80) = **80%** → pokemon is added
- `pokemon` (count: 1000) → neighbor `ashketchum` (20) = **2%** → ashketchum is NOT added

This means "ashketchum usually appears with pokemon" but "pokemon rarely appears with ashketchum" — which matches real-world semantics.

### Counts are decayable

A periodic decay job (`models/job/jobs/decay-hashtag-stats.js`, every 6 hours) applies a time-weighted decay factor to all `count` values and neighbor counts. This ensures:

- Old/stale hashtag relationships fade over time
- Trending associations grow stronger while outdated ones diminish
- Tags with `count ≤ 0` after decay are automatically deleted

The decay formula accounts for how long since the document was last updated — more stale documents decay faster.

### Bounded neighbors

Only the top 48 co-occurring tags are kept per document (sorted by count descending). This bounds storage per document and ensures only meaningful associations are retained.

### Language scoping

All statistics are language-scoped. A hashtag `#football` in English (`en:football`) and Portuguese (`pt:football`) are tracked as separate documents with independent counts and neighbor associations.

## Related files

| File | Role |
|------|------|
| `models/hashtag-stats/schema.js` | MeiliSearch index schema definition |
| `services/event/tracker/mdb/hashtag-stats.js` | In-memory accumulator + flush logic |
| `services/topic/detector.js` | Cache-backed topic detection engine |
| `helpers/hashtag.js` | Hashtag extraction, normalization, word splitting, acronym, morphological synonyms |
| `models/job/jobs/flush-hashtag-stats.js` | Periodic flush job (60s) |
| `models/job/jobs/decay-hashtag-stats.js` | Periodic decay job (6h) |
| `models/job/jobs/process-pending-ops/index.js` | Processes `mergeHashtagStats` ops |
| `services/event/saver/mdb/index.js` | Integration point: extraction → detection → tracking |
