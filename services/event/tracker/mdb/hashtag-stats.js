/**
 * In-memory hashtag co-occurrence accumulator.
 * Tracks per-language hashtag counts and pairwise co-occurrences.
 * Flushed periodically to MeiliSearch via mergeHashtagStats pending ops.
 */
import { queueOps } from '#services/event/maintainer/mdb/index.js'

const MAX_DIRECT_TAGS = 8

// Map<lang, { tags: Map<tag, { count, neighbors: Map<tag, count>, words, acronym }> }>
const localStats = new Map()

function ensureLang (lang) {
  if (!localStats.has(lang)) {
    localStats.set(lang, { tags: new Map() })
  }
  return localStats.get(lang)
}

/**
 * Track hashtag occurrences and co-occurrences for a persisted event.
 *
 * @param {{ language: string, hashtags: { tag: string, words: string[], acronym: string|null }[] }} params
 */
export function trackHashtagStats ({ language, hashtags }) {
  if (!language) return

  const langStats = ensureLang(language)

  if (!hashtags?.length) {
    return
  }

  // Limit to MAX_DIRECT_TAGS unique tags per event
  const tags = hashtags.slice(0, MAX_DIRECT_TAGS)

  for (const h of tags) {
    let entry = langStats.tags.get(h.tag)
    if (!entry) {
      entry = { count: 0, neighbors: new Map(), words: h.words, acronym: h.acronym }
      langStats.tags.set(h.tag, entry)
    }
    entry.count++

    // Pairwise co-occurrence: for each other tag in this event
    for (const other of tags) {
      if (other.tag === h.tag) continue
      entry.neighbors.set(other.tag, (entry.neighbors.get(other.tag) || 0) + 1)
    }
  }
}

/**
 * Snapshot local accumulator, reset it, and queue mergeHashtagStats ops.
 */
export async function flushHashtagStatsToMDB () {
  if (localStats.size === 0) return

  // Snapshot and reset
  const snapshot = new Map(localStats)
  localStats.clear()

  const ops = []

  for (const [lang, langStats] of snapshot) {
    // Queue per-tag ops
    for (const [tag, entry] of langStats.tags) {
      const neighborDeltas = []
      for (const [neighborTag, count] of entry.neighbors) {
        neighborDeltas.push([neighborTag, count])
      }

      ops.push({
        type: 'mergeHashtagStats',
        data: {
          key: `${lang}:${tag}`,
          docType: 'tag',
          lang,
          tag,
          words: entry.words,
          acronym: entry.acronym,
          countDelta: entry.count,
          neighborDeltas,
          seenAt: Date.now()
        }
      })
    }
  }

  if (ops.length > 0) {
    try {
      console.log(`Flushing hashtag stats: ${ops.length} ops`)
      await queueOps(ops)
    } catch (err) {
      console.error('Failed to queue hashtag stats ops', err)
    }
  }
}
