/**
 * Cache-backed topic detection engine.
 * Infers topics for events using an in-memory cache of hashtagStats,
 * refreshed periodically from MeiliSearch.
 * Never reads MeiliSearch on the hot path per event.
 */
import mdb from '#services/db/mdb.js'
import { sanitizeText } from '#helpers/language.js'
import { areMorphologicalSynonyms } from '#helpers/hashtag.js'

// --- Tunable constants ---
const CACHE_SIZE_PER_LANG = 500
const CACHE_REFRESH_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes
const DIRECTIONAL_RATIO = 0.3
const MIN_NEIGHBOR_COUNT = 2
const MIN_TAG_COUNT_FOR_INFERENCE = 3
const STRONG_TOKEN_MIN_LENGTH = 5
const MAX_TOPICS = 12
const MIN_SOURCE_COUNT_FOR_EXPANSION = 10
const SEMANTIC_SIMILARITY_THRESHOLD = 0.60
const MAX_SEMANTIC_TOPICS = 3

// --- Cache ---
// Map<lang, { byTag, byWord, byAcronym, docs[], refreshedAt }>
const cache = new Map()
let isRefreshing = false

/**
 * Refreshes the cache for a given language if stale or missing.
 * Non-blocking: returns immediately if already refreshing.
 */
async function maybeRefreshCache (lang) {
  if (!lang) return
  const entry = cache.get(lang)
  if (entry && Date.now() - entry.refreshedAt < CACHE_REFRESH_INTERVAL_MS) return
  if (isRefreshing) return

  isRefreshing = true
  try {
    const { hits } = await mdb.index('hashtagStats').search('', {
      filter: `lang = ${JSON.stringify(lang)}`,
      sort: ['count:desc'],
      limit: CACHE_SIZE_PER_LANG,
      attributesToRetrieve: ['key', 'tag', 'words', 'acronym', 'count', 'neighbors', 'embedding']
    })

    const byTag = new Map()
    const byWord = new Map() // word → Set<tag>
    const byAcronym = new Map() // acronym → Set<tag>

    for (const doc of hits) {
      byTag.set(doc.tag, doc)

      if (doc.words?.length) {
        for (const w of doc.words) {
          if (!byWord.has(w)) byWord.set(w, new Set())
          byWord.get(w).add(doc.tag)
        }
      }

      if (doc.acronym) {
        if (!byAcronym.has(doc.acronym)) byAcronym.set(doc.acronym, new Set())
        byAcronym.get(doc.acronym).add(doc.tag)
      }
    }

    const embeddings = new Map()
    for (const doc of hits) {
      if (doc.embedding?.length) {
        embeddings.set(doc.tag, new Float32Array(doc.embedding))
      }
    }

    cache.set(lang, { byTag, byWord, byAcronym, embeddings, docs: hits, refreshedAt: Date.now() })
  } catch (err) {
    // Silently fail — cache remains stale or empty
    if (err.code !== 'index_not_found' && err.cause?.code !== 'index_not_found') {
      console.error('Failed to refresh topic detection cache:', err)
    }
  } finally {
    isRefreshing = false
  }
}

/**
 * Expands topics by adding neighbors above the directional ratio threshold.
 * Iterates over a snapshot of current topics to avoid infinite expansion.
 */
function expandNeighbors (topics, langCache, tagsToExpand) {
  const snapshot = tagsToExpand || [...topics]
  for (const tag of snapshot) {
    const doc = langCache.byTag.get(tag)
    if (!doc?.neighbors?.length || !doc.count) continue
    if (doc.count < MIN_SOURCE_COUNT_FOR_EXPANSION) continue

    for (const [neighborTag, neighborCount] of doc.neighbors) {
      if (topics.has(neighborTag)) continue
      if (neighborCount < MIN_NEIGHBOR_COUNT) continue
      if (neighborCount / doc.count >= DIRECTIONAL_RATIO) {
        topics.add(neighborTag)
      }
    }
  }
}

/**
 * Detect topics for an event.
 *
 * @param {{ language: string|undefined, hashtags: { tag: string, words: string[], acronym: string|null }[], text: string|undefined }} params
 * @returns {string[]} normalized topic tags
 */
export async function detectTopics ({ language, hashtags = [], text }) {
  const topics = new Set()

  // Phase 1: Direct hashtags
  for (const h of hashtags) {
    topics.add(h.tag)
  }

  const langCache = language ? cache.get(language) : null

  if (langCache) {
    // Phase 2: Directional neighbor expansion (for direct hashtags)
    expandNeighbors(topics, langCache)

    // Phase 3: Synonym expansion (cache-only)
    const topicsBeforePhase3 = new Set(topics)
    const currentTopics = [...topics]
    for (const tag of currentTopics) {
      const doc = langCache.byTag.get(tag)
      if (!doc) continue

      // 3a: Morphological synonyms
      for (const [otherTag] of langCache.byTag) {
        if (topics.has(otherTag)) continue
        if (areMorphologicalSynonyms(tag, otherTag, language)) {
          topics.add(otherTag)
        }
      }

      // 3b: Acronym synonyms
      if (doc.acronym) {
        // Forward: other tags that share the same acronym
        const acronymCandidates = langCache.byAcronym.get(doc.acronym)
        if (acronymCandidates && acronymCandidates.size <= 2) {
          for (const candidate of acronymCandidates) {
            if (candidate !== tag) topics.add(candidate)
          }
        }
        // Forward: if the acronym itself is a known tag, add it
        if (langCache.byTag.has(doc.acronym) && !topics.has(doc.acronym)) {
          topics.add(doc.acronym)
        }
      }
      // Reverse: if this tag IS the acronym of another tag
      for (const [otherTag, otherDoc] of langCache.byTag) {
        if (topics.has(otherTag)) continue
        if (otherDoc.acronym === tag) {
          // Only if the acronym-tag is not ambiguous
          const candidates = langCache.byAcronym.get(tag)
          if (!candidates || candidates.size <= 2) {
            topics.add(otherTag)
          }
        }
      }

      // 3c: Context-based synonyms (prefix + shared top neighbors)
      if (doc.neighbors?.length >= 3) {
        const topNeighbors = new Set(doc.neighbors.slice(0, 3).map(n => n[0]))
        for (const [otherTag, otherDoc] of langCache.byTag) {
          if (topics.has(otherTag)) continue
          // One must be prefix of the other
          if (!tag.startsWith(otherTag) && !otherTag.startsWith(tag)) continue
          if (!otherDoc.neighbors?.length) continue
          const otherTopNeighbors = new Set(otherDoc.neighbors.slice(0, 3).map(n => n[0]))
          let shared = 0
          for (const n of topNeighbors) {
            if (otherTopNeighbors.has(n)) shared++
          }
          if (shared >= 2) topics.add(otherTag)
        }
      }
    }

    // Phase 4: No-hashtag text inference
    if (hashtags.length === 0 && text) {
      const sanitized = sanitizeText(text)
      if (sanitized) {
        const tokens = sanitized.toLowerCase().split(/[\s\p{P}]+/u).filter(t => t.length >= 2)
        const uniqueTokens = [...new Set(tokens)]

        // Score candidates
        const candidateScores = new Map() // tag → score

        for (const token of uniqueTokens) {
          // Exact tag match
          if (langCache.byTag.has(token)) {
            const doc = langCache.byTag.get(token)
            if (doc.count >= MIN_TAG_COUNT_FOR_INFERENCE) {
              candidateScores.set(token, (candidateScores.get(token) || 0) + 3)
            }
          }

          // Split-word match
          const wordTags = langCache.byWord.get(token)
          if (wordTags) {
            for (const tag of wordTags) {
              const doc = langCache.byTag.get(tag)
              if (doc && doc.count >= MIN_TAG_COUNT_FOR_INFERENCE) {
                candidateScores.set(tag, (candidateScores.get(tag) || 0) + 2)
              }
            }
          }

          // Acronym match
          const acronymTags = langCache.byAcronym.get(token)
          if (acronymTags && acronymTags.size <= 2) {
            for (const tag of acronymTags) {
              candidateScores.set(tag, (candidateScores.get(tag) || 0) + 1)
            }
          }
        }

        // Strong unique token: length ≥ 5, maps to exactly 1 tag, score ≥ 3
        for (const [tag, score] of candidateScores) {
          if (score >= 3 && tag.length >= STRONG_TOKEN_MIN_LENGTH) {
            // Check uniqueness: this tag shouldn't be a word in many other tags
            const wordMappings = langCache.byWord.get(tag)
            if (!wordMappings || wordMappings.size <= 1) {
              topics.add(tag)
            }
          }
        }

        // Two related candidates: if at least 2 candidates are neighbors of each other
        const candidateTags = [...candidateScores.keys()]
        for (let i = 0; i < candidateTags.length; i++) {
          for (let j = i + 1; j < candidateTags.length; j++) {
            const tagA = candidateTags[i]
            const tagB = candidateTags[j]
            const docA = langCache.byTag.get(tagA)
            const docB = langCache.byTag.get(tagB)

            const aHasB = docA?.neighbors?.some(n => n[0] === tagB)
            const bHasA = docB?.neighbors?.some(n => n[0] === tagA)

            if (aHasB || bHasA) {
              topics.add(tagA)
              topics.add(tagB)
            }
          }
        }
      }
    }

    // Expand neighbors only for topics newly added in Phases 3-4 (not transitively)
    const newlyAdded = [...topics].filter(t => !topicsBeforePhase3.has(t))
    if (newlyAdded.length > 0) {
      expandNeighbors(topics, langCache, newlyAdded)
    }

    // Phase 5: Semantic text inference (embedding-based)
    // Only runs when: no hashtags, Phase 4 found nothing, text exists, cache has embeddings
    if (hashtags.length === 0 && topics.size === 0 && text && langCache.embeddings?.size > 0) {
      // Must be a dynamic import for mocking in tests
      const { embedText, cosineSimilarity } = await import('#services/topic/embedder.js')
      const textEmbedding = await embedText(text)

      if (textEmbedding) {
        const scored = []
        for (const [tag, topicEmbedding] of langCache.embeddings) {
          const sim = cosineSimilarity(textEmbedding, topicEmbedding)
          if (sim >= SEMANTIC_SIMILARITY_THRESHOLD) {
            scored.push({ tag, sim })
          }
        }

        scored.sort((a, b) => b.sim - a.sim)
        for (const { tag } of scored.slice(0, MAX_SEMANTIC_TOPICS)) {
          topics.add(tag)
        }

        if (topics.size > 0) {
          expandNeighbors(topics, langCache)
        }
      }
    }
  }

  // Trigger async cache refresh for next time (non-blocking)
  if (language) maybeRefreshCache(language)

  // Return bounded result
  const result = [...topics].slice(0, MAX_TOPICS)
  return result.length > 0 ? result : undefined
}

/**
 * Force-refresh cache for a language (used in tests).
 */
export async function refreshCacheForLang (lang) {
  isRefreshing = false // reset flag
  const entry = cache.get(lang)
  if (entry) entry.refreshedAt = 0
  await maybeRefreshCache(lang)
}

export { cache as _cache }
