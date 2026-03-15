// https://sharp.pixelplumbing.com/install#heroku
// https://github.com/gaffneyc/heroku-buildpack-jemalloc
import { Writable } from 'node:stream'
import sharp from 'sharp'

const BYTE_SIZE_LIMIT = 20 * 1024           // 20 KB output limit
const TARGET_SIZE = 512                      // 512x512
const MAX_SOURCE_BYTES = 10 * 1024 * 1024   // 10 MB source limit
const FETCH_TIMEOUT_MS = 30_000             // 30 s

/**
 * Fetches an image from a URL, resizes it to 512x512 webp,
 * and returns a base64 data URL.
 *
 * Fails fast if content-length or accumulated streamed bytes exceed MAX_SOURCE_BYTES.
 *
 * @param {string} imageUrl
 * @returns {Promise<string>} data:image/webp;base64,…
 */
export async function processImage (imageUrl) {
  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`)
  }

  const contentLength = response.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > MAX_SOURCE_BYTES) {
    throw new Error(`Image too large: content-length ${contentLength} B exceeds ${MAX_SOURCE_BYTES} B limit`)
  }

  // Stream the body with a running byte count to abort mid-download if needed
  const chunks = []
  let totalBytes = 0
  for await (const chunk of response.body) {
    totalBytes += chunk.length
    if (totalBytes > MAX_SOURCE_BYTES) {
      throw new Error(`Image download exceeded ${MAX_SOURCE_BYTES} B limit`)
    }
    chunks.push(chunk)
  }

  const buffer = await resizeImage({
    input: Buffer.concat(chunks),
    resizeOptions: { width: TARGET_SIZE, height: TARGET_SIZE }
  })

  return `data:image/webp;base64,${buffer.toString('base64')}`
}

/**
 * Resizes and encodes an image as webp, iteratively reducing quality until
 * the output fits within byteLimit.
 *
 * Operates entirely in-memory (no temp files); safe because the output is
 * always bounded to TARGET_SIZE × TARGET_SIZE pixels (~1 MB uncompressed).
 *
 * @param {{ input: Buffer, resizeOptions: object, byteLimit?: number, quality?: number, qualityStep?: number, smartSubsample?: boolean }} opts
 * @returns {Promise<Buffer>}
 */
export async function resizeImage ({ input, resizeOptions, byteLimit = BYTE_SIZE_LIMIT, quality = 75, qualityStep = 5, smartSubsample = false }) {
  resizeOptions = {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
    ...resizeOptions
  }
  return _resizeToLimit(input, resizeOptions, byteLimit, quality, qualityStep, smartSubsample)
}

/**
 * Recursive helper — always re-encodes from the original input to avoid
 * cascading quality loss between iterations.
 *
 * Intermediate encodings that exceed byteLimit are streamed through a byte
 * counter and discarded without ever fully materialising as a JS Buffer.
 * Only the final passing encode is returned as a Buffer.
 */
async function _resizeToLimit (originalInput, resizeOptions, byteLimit, quality, qualityStep, smartSubsample) {
  // At the quality floor we must return something regardless of size
  const limit = (quality === 1 && smartSubsample) ? Infinity : byteLimit

  const buffer = await _encode(originalInput, resizeOptions, quality, smartSubsample, limit)
  if (buffer !== null) return buffer

  const nextQuality = Math.max(1, quality - qualityStep)
  const nextSmartSubsample = (quality === 1 && nextQuality === 1 && !smartSubsample) ? true : smartSubsample

  return _resizeToLimit(originalInput, resizeOptions, byteLimit, nextQuality, qualityStep, nextSmartSubsample)
}

/**
 * Encodes the image and streams output through a byte counter.
 * Returns a Buffer if total bytes ≤ limit, or null if the limit is exceeded.
 * Chunks beyond the limit are not accumulated in memory.
 */
function _encode (input, resizeOptions, quality, smartSubsample, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let totalBytes = 0
    let settled = false

    const sink = new Writable({
      write (chunk, _enc, callback) {
        totalBytes += chunk.length
        if (!settled && totalBytes > limit) {
          settled = true
          resolve(null)
        } else if (!settled) {
          chunks.push(chunk)
        }
        callback()
      },
      final (callback) {
        if (!settled) resolve(Buffer.concat(chunks))
        callback()
      }
    })

    const pipeline = sharp(input, { pages: 1 })
      .rotate() // auto-orient based on EXIF
      .resize(resizeOptions)
      .webp({ quality, smartSubsample })
      .timeout({ seconds: 20 })

    pipeline.on('error', (err) => { if (!settled) { settled = true; reject(err) } })
    sink.on('error', (err) => { if (!settled) { settled = true; reject(err) } })
    pipeline.pipe(sink)
  })
}

export { BYTE_SIZE_LIMIT, TARGET_SIZE, MAX_SOURCE_BYTES, FETCH_TIMEOUT_MS }
