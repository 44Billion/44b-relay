import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { processImage, resizeImage, MAX_SOURCE_BYTES } from '#services/topic/image-processor.js'

/** Creates a small synthetic PNG buffer for testing */
async function makeTestImage (width = 100, height = 100) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 100, b: 50, alpha: 1 } }
  }).png().toBuffer()
}

/**
 * Installs a mock for global `fetch` that returns the given buffer as the response body.
 * Pass contentLength: null to omit the header (simulates a server that doesn't send it).
 */
function mockFetch (imageBuffer, { contentLength, status = 200 } = {}) {
  const headers = new Headers()
  if (contentLength != null) headers.set('content-length', String(contentLength))

  const stream = new ReadableStream({
    start (controller) {
      controller.enqueue(new Uint8Array(imageBuffer))
      controller.close()
    }
  })

  mock.method(globalThis, 'fetch', async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers,
    body: stream
  }))
}

// ---------------------------------------------------------------------------

describe('resizeImage', () => {
  it('returns a Buffer', async () => {
    const input = await makeTestImage()
    const result = await resizeImage({ input, resizeOptions: { width: 512, height: 512 } })
    assert.ok(Buffer.isBuffer(result))
  })

  it('output is valid webp', async () => {
    const input = await makeTestImage()
    const result = await resizeImage({ input, resizeOptions: { width: 512, height: 512 } })
    const meta = await sharp(result).metadata()
    assert.equal(meta.format, 'webp')
  })

  it('output dimensions are 512x512 for a square source', async () => {
    const input = await makeTestImage(200, 200)
    const result = await resizeImage({ input, resizeOptions: { width: 512, height: 512 } })
    const meta = await sharp(result).metadata()
    assert.equal(meta.width, 512)
    assert.equal(meta.height, 512)
  })

  it('contains the image within 512x512 without cropping for non-square source', async () => {
    const input = await makeTestImage(200, 400) // portrait
    const result = await resizeImage({ input, resizeOptions: { width: 512, height: 512 } })
    const meta = await sharp(result).metadata()
    assert.ok(meta.width <= 512)
    assert.ok(meta.height <= 512)
  })

  it('reduces quality to fit within byteLimit', async () => {
    const input = await makeTestImage(512, 512)
    // 1 KB — forces aggressive quality reduction
    const result = await resizeImage({ input, resizeOptions: { width: 512, height: 512 }, byteLimit: 1 * 1024 })
    assert.ok(Buffer.isBuffer(result))
    // Quality floor guarantees we always get *some* output
    assert.ok(result.length > 0)
  })

  it('returns the buffer immediately when first attempt fits byteLimit', async () => {
    const input = await makeTestImage(10, 10)
    // 100 KB limit — a tiny image will always fit
    const result = await resizeImage({ input, resizeOptions: { width: 512, height: 512 }, byteLimit: 100 * 1024 })
    assert.ok(result.length <= 100 * 1024)
  })
})

// ---------------------------------------------------------------------------

describe('processImage', () => {
  afterEach(() => mock.restoreAll())

  it('returns a data:image/webp;base64 string', async () => {
    const img = await makeTestImage()
    mockFetch(img)
    const result = await processImage('https://example.com/icon.png')
    assert.ok(result.startsWith('data:image/webp;base64,'))
  })

  it('base64 payload decodes to a valid webp', async () => {
    const img = await makeTestImage()
    mockFetch(img)
    const result = await processImage('https://example.com/icon.png')
    const b64 = result.replace('data:image/webp;base64,', '')
    const buf = Buffer.from(b64, 'base64')
    const meta = await sharp(buf).metadata()
    assert.equal(meta.format, 'webp')
  })

  it('throws on non-ok HTTP response', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers(),
      body: new ReadableStream({ start (c) { c.close() } })
    }))
    await assert.rejects(
      () => processImage('https://example.com/icon.png'),
      /404/
    )
  })

  it('throws when content-length header exceeds MAX_SOURCE_BYTES', async () => {
    const img = await makeTestImage()
    mockFetch(img, { contentLength: MAX_SOURCE_BYTES + 1 })
    await assert.rejects(
      () => processImage('https://example.com/icon.png'),
      /too large/i
    )
  })

  it('throws when streamed bytes exceed MAX_SOURCE_BYTES (no content-length)', async () => {
    // A chunk bigger than the limit but without a content-length header
    const bigChunk = Buffer.alloc(MAX_SOURCE_BYTES + 1)
    const stream = new ReadableStream({
      start (controller) {
        controller.enqueue(new Uint8Array(bigChunk))
        controller.close()
      }
    })
    mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      body: stream
    }))
    await assert.rejects(
      () => processImage('https://example.com/icon.png'),
      /exceeded/i
    )
  })
})
