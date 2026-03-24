import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { limitNostrMessageLength } from '#services/relay/nostr-message-handler/index.js'
import { eventKinds } from '#constants/event.js'

describe('limitNostrMessageLength', () => {
  const createWs = () => ({
    send: mock.fn()
  })

  it('should invalidate TEXT_NOTE if content too long (without data image)', () => {
    const ws = createWs()
    const content = 'a'.repeat(9 * 1024)
    const nostrMessage = ['EVENT', { kind: eventKinds.TEXT_NOTE, content }]
    nostrMessage.byteLength = content.length + 100 // approximation

    const result = limitNostrMessageLength({ ws, nostrMessage })
    assert.strictEqual(result.isInvalid, true)
  })

  it('should validate TEXT_NOTE if content within limit after removing data image', () => {
    const ws = createWs()
    // 10KB total, but 5KB is data image
    const dataImage = 'data:image/png;base64,abcdef'
    const content = 'a'.repeat(4 * 1024) + dataImage
    const nostrMessage = ['EVENT', { kind: eventKinds.TEXT_NOTE, content }]
    nostrMessage.byteLength = content.length + 100

    const result = limitNostrMessageLength({ ws, nostrMessage })
    assert.strictEqual(result.isInvalid, false)
  })

  it('should validate FOLLOWS event up to 128KB', () => {
    const ws = createWs()
    const nostrMessage = ['EVENT', { kind: eventKinds.FOLLOWS, tags: [] }]
    nostrMessage.byteLength = 127 * 1024

    const result = limitNostrMessageLength({ ws, nostrMessage })
    assert.strictEqual(result.isInvalid, false)
  })

  it('should invalidate FOLLOWS event over 128KB', () => {
    const ws = createWs()
    const nostrMessage = ['EVENT', { kind: eventKinds.FOLLOWS, tags: [] }]
    nostrMessage.byteLength = 129 * 1024

    const result = limitNostrMessageLength({ ws, nostrMessage })
    assert.strictEqual(result.isInvalid, true)
  })

  it('should validate MAIN_SITE_MANIFEST up to 128KB', () => {
    const ws = createWs()
    const nostrMessage = ['EVENT', { kind: eventKinds.MAIN_SITE_MANIFEST, tags: [] }]
    nostrMessage.byteLength = 128 * 1024

    const result = limitNostrMessageLength({ ws, nostrMessage })
    assert.strictEqual(result.isInvalid, false)
  })

  it('should invalidate generic events over 4KB', () => {
    const ws = createWs()
    const nostrMessage = ['EVENT', { kind: 999, tags: [] }]
    nostrMessage.byteLength = 5 * 1024

    const result = limitNostrMessageLength({ ws, nostrMessage })
    assert.strictEqual(result.isInvalid, true)
  })

  it('should validate REQ messages within the formula limit', () => {
    const ws = createWs()
    const nostrMessage = ['REQ', 'sub-id', {}]
    nostrMessage.byteLength = (64 * 500 * 10) + 512

    const result = limitNostrMessageLength({ ws, nostrMessage })
    assert.strictEqual(result.isInvalid, false)
  })

  it('should invalidate BINARY_DATA_CHUNK if content too short and not last chunk', () => {
    const ws = createWs()
    const content = 'a'.repeat(50000) // less than 58286
    const nostrMessage = [
      'EVENT',
      {
        kind: eventKinds.BINARY_DATA_CHUNK,
        content,
        tags: [['c', 'root:0', '10']] // index 0, total 10 -> not last
      }
    ]
    nostrMessage.byteLength = content.length + 100

    const result = limitNostrMessageLength({ ws, nostrMessage })
    assert.strictEqual(result.isInvalid, true)
  })

  it('should validate BINARY_DATA_CHUNK if content too short and IS last chunk', () => {
    const ws = createWs()
    const content = 'a'.repeat(50000)
    const nostrMessage = [
      'EVENT',
      {
        kind: eventKinds.BINARY_DATA_CHUNK,
        content,
        tags: [['c', 'root:9', '10']] // index 9, total 10 -> is last
      }
    ]
    nostrMessage.byteLength = content.length + 100

    const result = limitNostrMessageLength({ ws, nostrMessage })
    assert.strictEqual(result.isInvalid, false)
  })
})
