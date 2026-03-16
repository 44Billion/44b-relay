#!/usr/bin/env node
/**
 * Downloads the MediaPipe Universal Sentence Encoder model for text embeddings.
 *
 * Run once: npm run download:mediapipe-model
 * The model file is gitignored and must be downloaded on each machine.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MODELS_DIR = join(__dirname, 'models')
const MODEL_PATH = join(MODELS_DIR, 'universal_sentence_encoder.tflite')

// Versioned URL (not /latest/) for reproducibility
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/text_embedder/universal_sentence_encoder/float32/1/universal_sentence_encoder.tflite'

mkdirSync(MODELS_DIR, { recursive: true })

if (existsSync(MODEL_PATH)) {
  console.log(`Model already exists at ${MODEL_PATH}`)
  process.exit(0)
}

console.log('Downloading Universal Sentence Encoder model (~300MB)...')
console.log(`From: ${MODEL_URL}`)
console.log(`To:   ${MODEL_PATH}`)

const res = await fetch(MODEL_URL)
if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)

const total = Number(res.headers.get('content-length') || 0)
let received = 0
const chunks = []

for await (const chunk of res.body) {
  chunks.push(chunk)
  received += chunk.length
  if (total) {
    const pct = ((received / total) * 100).toFixed(1)
    process.stdout.write(`\r${pct}% (${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(0)} MB)`)
  }
}

process.stdout.write('\n')
writeFileSync(MODEL_PATH, Buffer.concat(chunks))
console.log(`Done. Model saved to ${MODEL_PATH}`)
