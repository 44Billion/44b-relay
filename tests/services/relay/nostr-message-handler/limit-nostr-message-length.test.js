import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { limitNostrMessageLength } from '#services/relay/nostr-message-handler/index.js'
import { eventKinds } from '#constants/event.js'
import { MAX_EVENT_BYTES, getJsonlChunkByteSize, wrapEvent } from 'libp2r2p/private-channel'
import { finalizeEvent } from 'libp2r2p/event'
import { generateSecretKey, getPublicKey } from 'libp2r2p/key'
import { encryptBase64 } from 'libp2r2p/nip44-v3'

function messageForEvent (event) {
  const nostrMessage = ['EVENT', event]
  nostrMessage.byteLength = Buffer.byteLength(JSON.stringify(nostrMessage))
  return nostrMessage
}

function privateEventOfSize (byteLength) {
  const event = {
    kind: eventKinds.PRIVATE_CHANNEL_BROADCAST,
    created_at: 1790689719,
    tags: [['s', 'a'.repeat(64)], ['expiration', '1791294519']],
    content: '',
    pubkey: 'b'.repeat(64),
    id: 'c'.repeat(64),
    sig: 'd'.repeat(128)
  }
  event.content = 'A'.repeat(byteLength - Buffer.byteLength(JSON.stringify(event)))
  return event
}

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

  it('should validate SIGNER_RPC (NIP-46) events up to 256KB', () => {
    const ws = createWs()
    const nostrMessage = ['EVENT', { kind: eventKinds.SIGNER_RPC, tags: [] }]
    // A sign_event wrapping a 128 KB follow/manifest measures ~219 KB.
    nostrMessage.byteLength = 219 * 1024

    const result = limitNostrMessageLength({ ws, nostrMessage })
    assert.strictEqual(result.isInvalid, false)
  })

  it('should invalidate SIGNER_RPC (NIP-46) events over 256KB', () => {
    const ws = createWs()
    const nostrMessage = ['EVENT', { kind: eventKinds.SIGNER_RPC, tags: [] }]
    nostrMessage.byteLength = 256 * 1024 + 1

    const result = limitNostrMessageLength({ ws, nostrMessage })
    assert.strictEqual(result.isInvalid, true)
  })

  for (const messageBytes of [3283, 55167, 65546]) {
    it(`should accept a private broadcast message of ${messageBytes} bytes`, () => {
      const ws = createWs()
      const nostrMessage = messageForEvent(privateEventOfSize(messageBytes - 10))
      assert.equal(nostrMessage.byteLength, messageBytes)
      assert.equal(limitNostrMessageLength({ ws, nostrMessage }).isInvalid, false)
      assert.equal(ws.send.mock.callCount(), 0)
    })
  }

  it('should reject a private broadcast one byte over the limit with its event id', () => {
    const ws = createWs()
    const event = privateEventOfSize(MAX_EVENT_BYTES + 1)
    const nostrMessage = messageForEvent(event)
    assert.equal(nostrMessage.byteLength, 65547)
    assert.equal(limitNostrMessageLength({ ws, nostrMessage }).isInvalid, true)
    assert.deepEqual(JSON.parse(ws.send.mock.calls[0].arguments[0]), [
      'OK', event.id, false, 'invalid: message is too long'
    ])
  })

  it('should measure private broadcast tags in UTF-8 bytes', () => {
    const ws = createWs()
    const event = privateEventOfSize(MAX_EVENT_BYTES)
    event.tags[0][1] = 'é' + event.tags[0][1].slice(1)
    const nostrMessage = messageForEvent(event)
    assert.equal(JSON.stringify(nostrMessage).length, 65546)
    assert.equal(nostrMessage.byteLength, 65547)
    assert.equal(limitNostrMessageLength({ ws, nostrMessage }).isInvalid, true)
  })

  it('should reject private broadcasts without string content', () => {
    for (const content of [undefined, null, 123, [], {}]) {
      const ws = createWs()
      const nostrMessage = messageForEvent({ ...privateEventOfSize(1000), content })
      assert.equal(limitNostrMessageLength({ ws, nostrMessage }).isInvalid, true)
    }
  })

  it('should accept every encrypted fragment produced by libp2r2p for a large private message', async () => {
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    const senderSigner = {
      getPublicKey: async () => pubkey,
      signEvent: async event => finalizeEvent(event, secretKey),
      nip44v3Encrypt: async (peer, kind, scope, plaintext) => encryptBase64(secretKey, peer, kind, scope, plaintext)
    }
    const storage = new Map()
    const events = await wrapEvent({
      senderSigner,
      receivers: [getPublicKey(generateSecretKey())],
      deletionPubkey: 'a'.repeat(64),
      event: { kind: eventKinds.CHAT_MESSAGE, created_at: 1790689719, tags: [], content: 'x'.repeat(getJsonlChunkByteSize() * 2) },
      temporaryStorageArea: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: key => storage.delete(key)
      }
    })

    assert.ok(events.length > 1)
    assert.ok(events.some(event => messageForEvent(event).byteLength === 55167))
    for (const event of events) {
      const ws = createWs()
      assert.ok(Buffer.byteLength(JSON.stringify(event)) <= MAX_EVENT_BYTES)
      assert.equal(limitNostrMessageLength({ ws, nostrMessage: messageForEvent(event) }).isInvalid, false)
      assert.equal(ws.send.mock.callCount(), 0)
    }
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

  it('should leave chunk structure and decoded size to the IRFS validator', () => {
    const ws = createWs()
    const content = 'a'.repeat(50000) // less than 58286
    const nostrMessage = [
      'EVENT',
      {
        kind: eventKinds.BINARY_DATA_CHUNK,
        content,
        tags: [['mmr', '0', '10', '']]
      }
    ]
    nostrMessage.byteLength = content.length + 100

    const result = limitNostrMessageLength({ ws, nostrMessage })
    assert.strictEqual(result.isInvalid, false)
  })

  it('should invalidate BINARY_DATA_CHUNK over 72 KiB', () => {
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
    nostrMessage.byteLength = 72 * 1024 + 1

    const result = limitNostrMessageLength({ ws, nostrMessage })
    assert.strictEqual(result.isInvalid, true)
  })

  it('should treat legacy kind 34600 as a generic 4 KiB event', () => {
    const ws = createWs()
    const nostrMessage = ['EVENT', { kind: 34600, content: 'a'.repeat(5000), tags: [] }]
    nostrMessage.byteLength = 5100

    const result = limitNostrMessageLength({ ws, nostrMessage })
    assert.strictEqual(result.isInvalid, true)
  })
})
