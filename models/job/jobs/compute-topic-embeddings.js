/**
 * Job: Compute Topic Embeddings
 *
 * Runs every 10 minutes. For each language with hashtagStats data,
 * fetches the top topics, computes text embeddings for those missing one
 * or whose content has changed, and stores the result back in hashtagStats.
 *
 * Topic text = tag words + top 5 neighbor words (gives semantic context).
 * An embeddingHash (integer) tracks content changes to avoid re-embedding
 * unchanged topics.
 */
import mdb from '#services/db/mdb.js'
import { embedTexts } from '#services/topic/embedder.js'

const MAX_TOPICS_PER_LANG = 500
const TOP_NEIGHBORS_FOR_CONTEXT = 5
const BATCH_SIZE = 32

export async function run () {
  console.log('Running compute-topic-embeddings...')

  const languages = await discoverLanguages()
  if (languages.length === 0) {
    console.log('No hashtagStats languages found, skipping embeddings.')
    return
  }

  for (const lang of languages) {
    try {
      await processLanguage(lang)
    } catch (err) {
      console.error(`Failed to compute embeddings for lang=${lang}:`, err)
    }
  }

  console.log('Done compute-topic-embeddings.')
}

async function discoverLanguages () {
  try {
    const { facetDistribution } = await mdb.index('hashtagStats').search('', {
      limit: 0,
      facets: ['lang']
    })
    return Object.keys(facetDistribution?.lang || {})
  } catch (err) {
    if (err.code === 'index_not_found' || err.cause?.code === 'index_not_found') return []
    throw err
  }
}

/**
 * Build the semantic text for a topic: its own words + top neighbor words.
 */
function buildTopicText (doc, wordsMap) {
  const parts = [...(doc.words?.length ? doc.words : [doc.tag])]
  for (const [neighborTag] of (doc.neighbors || []).slice(0, TOP_NEIGHBORS_FOR_CONTEXT)) {
    const neighborWords = wordsMap.get(neighborTag)
    if (neighborWords?.length) {
      parts.push(...neighborWords)
    } else {
      parts.push(neighborTag)
    }
  }
  return parts.join(' ')
}

/**
 * Simple string hash to detect content changes.
 * Returns a 32-bit integer.
 */
function simpleHash (str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}

async function processLanguage (lang) {
  const { hits: topTopics } = await mdb.index('hashtagStats').search('', {
    filter: `lang = ${JSON.stringify(lang)}`,
    sort: ['count:desc'],
    limit: MAX_TOPICS_PER_LANG,
    attributesToRetrieve: ['key', 'tag', 'words', 'neighbors', 'embeddingHash']
  })

  if (topTopics.length === 0) return

  const wordsMap = new Map(topTopics.map(s => [s.tag, s.words]))

  // Identify topics whose content has changed (or that have no embedding yet)
  const needsEmbedding = []
  for (const doc of topTopics) {
    const text = buildTopicText(doc, wordsMap)
    const hash = simpleHash('passage: ' + text)
    if (doc.embeddingHash !== hash) {
      needsEmbedding.push({ doc, text, hash })
    }
  }

  if (needsEmbedding.length === 0) return

  console.log(`Computing ${needsEmbedding.length} embeddings for lang=${lang}...`)

  for (let i = 0; i < needsEmbedding.length; i += BATCH_SIZE) {
    const batch = needsEmbedding.slice(i, i + BATCH_SIZE)
    const texts = batch.map(b => 'passage: ' + b.text)
    const embeddings = await embedTexts(texts)

    if (!embeddings) {
      console.warn('Embedding model not available, skipping compute-topic-embeddings.')
      return
    }

    const documents = batch.map((b, j) => ({
      key: b.doc.key,
      embedding: Array.from(embeddings[j]),
      embeddingHash: b.hash
    }))

    await mdb.index('hashtagStats').updateDocuments(documents)
  }
}

const config = {
  key: 'computeTopicEmbeddings',
  frequency: 10 * 60, // Every 10 minutes
  shouldUseLock: true,
  run
}

export default config
