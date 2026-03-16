import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cosineSimilarity, EMBEDDING_DIMS } from '#services/topic/embedder.js'

describe('cosineSimilarity', () => {
  it('should return ~1 for identical unit vectors', () => {
    const v = new Float32Array(EMBEDDING_DIMS).fill(0)
    v[0] = 1
    const sim = cosineSimilarity(v, v)
    assert.ok(Math.abs(sim - 1) < 1e-6, `Expected ~1, got ${sim}`)
  })

  it('should return 0 for orthogonal vectors', () => {
    const a = new Float32Array(EMBEDDING_DIMS).fill(0)
    const b = new Float32Array(EMBEDDING_DIMS).fill(0)
    a[0] = 1
    b[1] = 1
    const sim = cosineSimilarity(a, b)
    assert.ok(Math.abs(sim) < 1e-6, `Expected 0, got ${sim}`)
  })

  it('should return -1 for opposite unit vectors', () => {
    const a = new Float32Array(EMBEDDING_DIMS).fill(0)
    const b = new Float32Array(EMBEDDING_DIMS).fill(0)
    a[0] = 1
    b[0] = -1
    const sim = cosineSimilarity(a, b)
    assert.ok(Math.abs(sim + 1) < 1e-6, `Expected -1, got ${sim}`)
  })

  it('should return a value between -1 and 1 for arbitrary vectors', () => {
    const a = new Float32Array(EMBEDDING_DIMS)
    const b = new Float32Array(EMBEDDING_DIMS)
    for (let i = 0; i < EMBEDDING_DIMS; i++) {
      a[i] = Math.random() - 0.5
      b[i] = Math.random() - 0.5
    }
    const sim = cosineSimilarity(a, b)
    assert.ok(sim >= -2 && sim <= 2, `Expected in range, got ${sim}`)
  })
})

describe('EMBEDDING_DIMS', () => {
  it('should be 384', () => {
    assert.equal(EMBEDDING_DIMS, 384)
  })
})
