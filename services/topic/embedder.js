/**
 * Text embedding service using Transformers.js (ONNX Runtime).
 *
 * Lazy-loads Xenova/multilingual-e5-small on first use.
 * Models are cached automatically by Transformers.js at
 * ~/.cache/huggingface/hub/ (configurable via HF_HOME env var).
 *
 * Gracefully degrades: if model loading fails, all methods return null
 * so topic detection continues without Phase 5 semantic matching.
 */
import { pipeline } from '@huggingface/transformers'

const MODEL_NAME = 'Xenova/multilingual-e5-small'

export const EMBEDDING_DIMS = 384

let extractor = null
let loadFailed = false
let loadPromise = null

async function ensureModel () {
  if (extractor) return extractor
  if (loadFailed) return null
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    try {
      extractor = await pipeline('feature-extraction', MODEL_NAME, { dtype: 'q8' })
      console.log(`Embedding model ${MODEL_NAME} loaded.`)
      return extractor
    } catch (err) {
      console.error(`Failed to load embedding model ${MODEL_NAME}:`, err)
      loadFailed = true
      return null
    } finally {
      loadPromise = null
    }
  })()

  return loadPromise
}

/**
 * Embed a single text string.
 * @param {string} text
 * @returns {Promise<Float32Array|null>} 384-dim normalized embedding or null on failure
 */
export async function embedText (text) {
  const model = await ensureModel()
  if (!model) return null

  try {
    const output = await model(text, { pooling: 'mean', normalize: true })
    return output.data
  } catch (err) {
    console.error('Embedding inference failed:', err)
    return null
  }
}

/**
 * Embed multiple texts in a batch.
 * @param {string[]} texts
 * @returns {Promise<Float32Array[]|null>} array of 384-dim embeddings or null on failure
 */
export async function embedTexts (texts) {
  if (!texts.length) return []
  const model = await ensureModel()
  if (!model) return null

  try {
    const output = await model(texts, { pooling: 'mean', normalize: true })
    // output.data is a flat Float32Array; reshape into per-text arrays
    const results = []
    for (let i = 0; i < texts.length; i++) {
      results.push(output.data.slice(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS))
    }
    return results
  } catch (err) {
    console.error('Batch embedding inference failed:', err)
    return null
  }
}

/**
 * Cosine similarity between two Float32Arrays.
 * Assumes both are already L2-normalized (which they are from normalize: true).
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
export function cosineSimilarity (a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
  }
  return dot
}
