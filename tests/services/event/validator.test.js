import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { eventKinds } from '#constants/event.js'
import { nostrClientMessages } from '#constants/message.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { serializeEvent } from '#helpers/event.js'
import EventValidator from '#services/event/validator.js'

describe('Event Validator', () => {
  // Helper to generate a valid signed event
  const generateValidEvent = (overrides = {}) => {
    const privKey = sha256(new TextEncoder().encode('test-private-key'))
    const pubKey = bytesToHex(schnorr.getPublicKey(privKey))

    const event = {
      pubkey: pubKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [],
      content: 'hello',
      ...overrides
    }

    const eventHash = sha256(new TextEncoder().encode(serializeEvent(event)))
    event.id = bytesToHex(eventHash)
    event.sig = bytesToHex(schnorr.sign(eventHash, privKey))

    return event
  }

  const validEvent = generateValidEvent()

  it('should reject non-object event', () => {
    const validator = new EventValidator({ event: null })
    const result = validator.isValid()
    assert.equal(result.isSuccess, false)
    assert.match(result.message, /wrong event/)
  })

  it('should validate valid event', () => {
    const validator = new EventValidator({ event: validEvent })
    const result = validator.isValid()
    assert.equal(result.isSuccess, true, result.message)
  })

  it('should reject if attributes missing', () => {
    const invalid = { ...validEvent }
    delete invalid.kind
    const validator = new EventValidator({ event: invalid })
    const result = validator.isValid()
    assert.equal(result.isSuccess, false)
    assert.match(result.message, /wrong attribute/)
  })

  it('should reject invalid content type', () => {
    const invalid = { ...validEvent, content: 123 }
    const validator = new EventValidator({ event: invalid })
    const result = validator.isValid()
    assert.equal(result.isSuccess, false)
    assert.match(result.message, /wrong attribute/)
  })

  it('should reject disallowed kind for message', () => {
    const validator = new EventValidator({
      event: { ...validEvent, kind: eventKinds.AUTH },
      // REQ message doesn't allow AUTH events
      clientMessage: nostrClientMessages.EVENT
    })
    const result = validator.isValid()
    assert.equal(result.isSuccess, false)
    assert.match(result.message, /wrong event kind/)
  })

  it('should reject personal copy events from the public relay', () => {
    const event = generateValidEvent({ kind: eventKinds.PERSONAL_COPY })
    const validator = new EventValidator({
      event,
      clientMessage: nostrClientMessages.EVENT
    })
    const result = validator.isValid()
    assert.equal(result.isSuccess, false)
    assert.match(result.message, /wrong event kind/)
  })

  describe('Tag Validation', () => {
    it('should validate valid expiration tag', () => {
      const event = {
        ...validEvent,
        tags: [['expiration', (Date.now() + 10000).toString()]]
      }
      const validator = new EventValidator({ event })
      assert.equal(validator.hasValidKnownTags(), true)
    })

    it('should reject invalid expiration tag', () => {
      const event = {
        ...validEvent,
        tags: [['expiration', 'not-a-number']]
      }
      const validator = new EventValidator({ event })
      assert.equal(validator.hasValidKnownTags(), false)
    })
  })

  describe('Data Validation (Content)', () => {
    it('should validate valid JSON for kind 0 (Metadata)', () => {
      const event = {
        ...validEvent,
        kind: eventKinds.METADATA,
        content: JSON.stringify({ name: 'bob' })
      }
      const validator = new EventValidator({ event })
      assert.equal(validator.hasValidData(), true)
    })

    it('should reject invalid JSON for kind 0', () => {
      const event = {
        ...validEvent,
        kind: eventKinds.METADATA,
        content: 'invalid json'
      }
      const validator = new EventValidator({ event })
      assert.equal(validator.hasValidData(), false)
    })
  })
})
