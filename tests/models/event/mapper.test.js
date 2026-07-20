import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_INDEXABLE_TAGS, MAX_INDEXABLE_TAG_VALUE_LENGTH, addressToRef, idToRef, eventToRecord, recordToEvent } from '#models/event/mapper.js'
import { OLD_EVENT_AUTH_REQUIRED_AFTER_SECONDS, eventKinds } from '#constants/event.js'

describe('Event Mapper', () => {
  describe('addressToRef', () => {
    it('should generate a base64 hash from a provided address string', () => {
      const address = '1:pubkey:dtag'
      const ref = addressToRef({ address })
      assert.ok(ref.length > 0)
      assert.equal(typeof ref, 'string')
    })

    it('should generate the same hash for the same parameters when address is not provided', () => {
      const params = { kind: 1, pubkey: 'abcdef', dTag: 'test' }
      const ref1 = addressToRef(params)
      const ref2 = addressToRef({ address: '1:abcdef:test' })
      assert.equal(ref1, ref2)
    })
  })

  describe('idToRef', () => {
    it('should convert a hex ID to a base64 string', () => {
      const id = '0000000000000000000000000000000000000000000000000000000000000000'
      const ref = idToRef(id)
      assert.ok(ref.length > 0)
      assert.equal(typeof ref, 'string')
      // 32 bytes to base64 should be around 43 chars (padding removed)
      assert.equal(ref.length, 43)
    })

    it('preserves the established Base64URL representation', () => {
      assert.equal(idToRef('f'.repeat(64)), `${'_'.repeat(42)}8`)
    })

    it('rejects malformed hexadecimal IDs', () => {
      assert.throws(() => idToRef('1g'.repeat(32)), /Invalid Base16/)
    })
  })

  describe('eventToRecord', () => {
    const baseEvent = {
      id: '0000000000000000000000000000000000000000000000000000000000000000',
      kind: 1,
      pubkey: 'pub',
      created_at: 123,
      sig: 'sig',
      tags: [],
      content: 'hello'
    }

    it('should map a simple event to a record', () => {
      const record = eventToRecord(baseEvent)
      assert.equal(record.id, baseEvent.id)
      assert.equal(record.kind, 1)
      assert.equal(record.pubkey, 'pub')
      assert.equal(record.nonFtsContent, 'hello')
      assert.ok(record.receivedAt)
      assert.ok(record.lastAccessedAt)
    })

    it('should separate indexable and non-indexable tags', () => {
      const event = {
        ...baseEvent,
        tags: [
          ['p', 'pubkey1'],
          ['t', 'topic'],
          ['longtag', 'value'], // Should NOT be indexable with /^[A-Za-z]$/
          ['123', 'invalid']
        ]
      }
      const record = eventToRecord(event)

      // 'p' and 't' match /^[A-Za-z]$/
      // 'longtag' and '123' do NOT match

      assert.equal(record.indexableTags.length, 2)
      assert.equal(record.indexableTags[0], 'p pubkey1')
      assert.equal(record.indexableTags[1], 't topic')

      assert.equal(record.nonIndexableTags.length, 2)
      assert.deepEqual(record.nonIndexableTags[0], ['longtag', 'value'])
      assert.deepEqual(record.nonIndexableTags[1], ['123', 'invalid'])
    })

    it('should index the private broadcast deletion pubkey s tag', () => {
      const deletionPubkey = 'a'.repeat(64)
      const record = eventToRecord({
        ...baseEvent,
        kind: 3560,
        tags: [['s', deletionPubkey], ['expiration', '1000000']]
      })

      assert.ok(record.indexableTags.includes(`s ${deletionPubkey}`))
    })

    it('should respect MAX_INDEXABLE_TAGS limit', () => {
      const tags = []
      for (let i = 0; i < 15; i++) {
        tags.push(['t', `tag${i}`])
      }
      const event = { ...baseEvent, tags }
      const record = eventToRecord(event)

      assert.equal(record.indexableTags.length, MAX_INDEXABLE_TAGS)
      assert.equal(record.nonIndexableTags.length, 5) // The rest
    })

    it('derives exact lowercase blobRefs from every r tag beyond the indexing cap', () => {
      const rootA = 'a'.repeat(64)
      const rootB = 'b'.repeat(64)
      const tags = Array.from({ length: MAX_INDEXABLE_TAGS }, (_, index) => ['t', `tag${index}`])
      tags.push(['r', rootA, 'path index.html'], ['r', rootB], ['r', rootA], ['r', 'A'.repeat(64)])

      const record = eventToRecord({ ...baseEvent, tags })
      assert.deepEqual(record.blobRefs, [rootA, rootB])
      assert.ok(record.nonIndexableTags.some(tag => tag[0] === 'r' && tag[1] === rootB))
    })

    it('should ignore indexable tags for specific kinds, except for "k" tag', () => {
      const event = {
        ...baseEvent,
        kind: 10003, // BOOKMARKS
        tags: [
          ['a', 'example1'],
          ['e', 'example2'],
          ['k', '1']
        ]
      }
      const record = eventToRecord(event)

      // Only 'k' should be indexable for kind 10003
      assert.equal(record.indexableTags.length, 1)
      assert.equal(record.indexableTags[0], 'k 1')

      assert.equal(record.nonIndexableTags.length, 2)
      assert.deepEqual(record.nonIndexableTags[0], ['a', 'example1'])
      assert.deepEqual(record.nonIndexableTags[1], ['e', 'example2'])
    })

    it('should handle expiration tags correctly', () => {
      const event = {
        ...baseEvent,
        tags: [['expiration', '1000000']]
      }
      const record = eventToRecord(event)
      assert.equal(record.expiresAt, 1000000)
    })

    it('should cap private delivery events at two days from receipt', () => {
      const receivedAt = 1_700_000_000
      const cap = receivedAt + 60 * 60 * 24 * 2
      const vipPubkey = 'fc7085c383ba71745704bdc1c6efcf7fab0197501de598c5e6c537ac0b32a4cb'
      const longExpiration = receivedAt + 60 * 60 * 24 * 10

      for (const kind of [eventKinds.PRIVATE_CHANNEL_BROADCAST, eventKinds.GIFT_WRAP]) {
        assert.equal(eventToRecord({ ...baseEvent, kind, tags: [] }, { receivedAt }).expiresAt, cap)
        assert.equal(eventToRecord({ ...baseEvent, kind, pubkey: vipPubkey, tags: [['expiration', String(longExpiration)]] }, { receivedAt }).expiresAt, cap)
      }
    })

    it('should retain a shorter private delivery expiration without changing other kinds', () => {
      const receivedAt = 1_700_000_000
      const shorterExpiration = receivedAt + 60 * 60
      const longerExpiration = receivedAt + 60 * 60 * 24 * 10

      for (const kind of [eventKinds.PRIVATE_CHANNEL_BROADCAST, eventKinds.GIFT_WRAP]) {
        const event = { ...baseEvent, kind, tags: [['expiration', String(shorterExpiration)]] }
        const record = eventToRecord(event, { receivedAt })
        assert.equal(record.expiresAt, shorterExpiration)
        assert.deepEqual(event.tags, [['expiration', String(shorterExpiration)]])
      }

      const ordinaryRecord = eventToRecord({ ...baseEvent, tags: [['expiration', String(longerExpiration)]] }, { receivedAt })
      assert.equal(ordinaryRecord.expiresAt, longerExpiration)
    })

    it('should limit deletion expiration to the old-event authentication window', () => {
      const hugeExp = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60) // 1 year
      const event = {
        ...baseEvent,
        kind: 5,
        tags: [['expiration', hugeExp.toString()]]
      }
      const record = eventToRecord(event)
      const maxAllowed = Math.floor(Date.now() / 1000) + OLD_EVENT_AUTH_REQUIRED_AFTER_SECONDS
      assert.ok(record.expiresAt <= maxAllowed)
    })

    it('should retain the three-day cap for reactions and reposts', () => {
      const hugeExp = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60)
      const maxAllowed = Math.floor(Date.now() / 1000) + (3 * 24 * 60 * 60)

      for (const kind of [eventKinds.REPOST, eventKinds.REACTION, eventKinds.GENERIC_REPOST]) {
        const record = eventToRecord({ ...baseEvent, kind, tags: [['expiration', hugeExp.toString()]] })
        assert.ok(record.expiresAt <= maxAllowed)
      }
    })

    it('should calculate address-based ref for parameterized replaceable events (kind 30000)', () => {
      const event = {
        ...baseEvent,
        kind: 30000,
        tags: [['d', 'my-tag']]
      }
      const record = eventToRecord(event)
      const expectedRef = addressToRef({ kind: 30000, pubkey: 'pub', dTag: 'my-tag' })
      assert.equal(record.ref, expectedRef)
    })

    it('should use ftsContent when isContentSearchable is true', () => {
      const record = eventToRecord(baseEvent, { isContentSearchable: true })
      assert.equal(record.ftsContent, 'hello')
      assert.equal(record.nonFtsContent, undefined)
    })

    it('should default dTag to empty string for kind 0', () => {
      const event = { ...baseEvent, kind: 0 }
      const record = eventToRecord(event)
      const expectedRef = addressToRef({ kind: 0, pubkey: baseEvent.pubkey, dTag: '' })
      assert.equal(record.ref, expectedRef)
    })

    it('should calculate dTag for reactions (kind 7) based on the last a/e/i/p tag', () => {
      const event = {
        ...baseEvent,
        kind: 7,
        tags: [
          ['e', 'event1'],
          ['p', 'pub1']
        ]
      }
      const record = eventToRecord(event)
      // Reversed: [['p', 'pub1'], ['e', 'event1']]
      // find(a,e,i) => ['e', 'event1']
      const expectedRef = addressToRef({ kind: 7, pubkey: baseEvent.pubkey, dTag: 'event1' })
      assert.equal(record.ref, expectedRef)
    })
  })

  describe('recordToEvent', () => {
    it('should reconstruct an event from a record', () => {
      const record = {
        id: 'abc',
        kind: 1,
        pubkey: 'pub',
        created_at: 123,
        sig: 'sig',
        nonFtsContent: 'hello',
        indexableTags: ['p pub1', 't tag1'],
        indexableTagExtras: [[0], [1]],
        nonIndexableTags: [['unknown', 'val']]
      }

      const event = recordToEvent(record)
      assert.equal(event.id, 'abc')
      assert.equal(event.content, 'hello')
      assert.equal(event.tags.length, 3)
      assert.deepEqual(event.tags[0], ['p', 'pub1'])
      assert.deepEqual(event.tags[1], ['t', 'tag1'])
      assert.deepEqual(event.tags[2], ['unknown', 'val'])
    })

    it('should preserve tag order during reconstruction', () => {
      const record = {
        id: 'abc',
        kind: 1,
        pubkey: 'pub',
        created_at: 123,
        sig: 'sig',
        nonFtsContent: 'hello',
        indexableTags: ['p pub1', 't tag1'],
        indexableTagExtras: [[2], [0]], // p pub1 at index 2, t tag1 at index 0
        nonIndexableTags: [['unknown', 'val']] // at original index 1 (implied)
      }

      // reconstruction logic in recordToEvent:
      // const tags = Array.isArray(nonIndexableTags) ? [...nonIndexableTags] : []
      // for (let i = 0; i < indexableTags.length; i++) {
      //   const [k, v] = indexableTags[i].split(' ', 2)
      //   const [tagIndex, ...extraValues] = indexableTagExtras[i]
      //   tags.splice(tagIndex, 0, [k, v, ...extraValues])
      // }

      // Let's trace it:
      // tags = [['unknown', 'val']]
      // i=0: k=p, v=pub1, index=2. tags.splice(2, 0, ['p', 'pub1']) => [['unknown', 'val'], ['p', 'pub1']]
      // i=1: k=t, v=tag1, index=0. tags.splice(0, 0, ['t', 'tag1']) => [['t', 'tag1'], ['unknown', 'val'], ['p', 'pub1']]

      const event = recordToEvent(record)
      assert.deepEqual(event.tags[0], ['t', 'tag1'])
      assert.deepEqual(event.tags[1], ['unknown', 'val'])
      assert.deepEqual(event.tags[2], ['p', 'pub1'])
    })

    it('should prioritize ftsContent over nonFtsContent if both are present during reconstruction', () => {
      const record = {
        id: '0000000000000000000000000000000000000000000000000000000000000000',
        kind: 1,
        pubkey: 'pub',
        created_at: 123,
        sig: 'sig',
        ftsContent: 'fts content',
        nonFtsContent: 'non-fts content'
      }
      const event = recordToEvent(record)
      assert.equal(event.content, 'fts content')
    })

    it('should preserve extra tag values during mapping and reconstruction', () => {
      const event = {
        id: '0000000000000000000000000000000000000000000000000000000000000000',
        kind: 1,
        pubkey: 'pub',
        created_at: 123,
        sig: 'sig',
        tags: [['p', 'pub1', 'relay1', 'petname1']],
        content: 'hello'
      }
      const record = eventToRecord(event)
      assert.deepEqual(record.indexableTagExtras[0], [0, 'relay1', 'petname1'])

      const reconstructed = recordToEvent(record)
      assert.deepEqual(reconstructed.tags[0], ['p', 'pub1', 'relay1', 'petname1'])
    })

    it('should accurately reconstruct an event with a mix of many indexable and non-indexable tags', () => {
      const originalEvent = {
        id: '0000000000000000000000000000000000000000000000000000000000000000',
        kind: 1,
        pubkey: 'pub123',
        created_at: 123456789,
        sig: 'sig123',
        content: 'hello world',
        tags: [
          ['t', 'topic1'], // indexable 1
          ['p', 'pubA', 'relayA'], // indexable 2
          ['unknown', 'val1'], // non-indexable
          ['e', 'eventA'], // indexable 3
          ['123', 'invalid'], // non-indexable
          ['d', 'my-d-tag'], // indexable 4
          ['long-key', 'val'], // non-indexable
          ['p', 'pubB'], // indexable 5
          ['z', 'valZ'], // indexable 6
          ['a', 'refA'], // indexable 7
          ['T', 'Topic2'], // indexable 8
          ['E', 'EventB'], // indexable 9
          ['r', 'relayB'], // indexable 10
          ['t', 'topic3'] // indexable 11 -> Should become non-indexable because of limit
        ]
      }

      const record = eventToRecord(originalEvent)

      // Check record integrity before reconstruction
      assert.equal(record.indexableTags.length, 10)
      assert.equal(record.nonIndexableTags.length, 4)

      const reconstructedEvent = recordToEvent(record)

      // Check fields
      assert.equal(reconstructedEvent.id, originalEvent.id)
      assert.equal(reconstructedEvent.kind, originalEvent.kind)
      assert.equal(reconstructedEvent.pubkey, originalEvent.pubkey)
      assert.equal(reconstructedEvent.content, originalEvent.content)
      assert.equal(reconstructedEvent.created_at, originalEvent.created_at)
      assert.equal(reconstructedEvent.sig, originalEvent.sig)

      // Check tags and their order
      assert.deepEqual(reconstructedEvent.tags, originalEvent.tags)
    })

    it('should stop adding new indexable tags when it reaches the MAX_INDEXABLE_TAG_VALUE_LENGTH limit', () => {
      const longValue = 'a'.repeat(MAX_INDEXABLE_TAG_VALUE_LENGTH + 1)
      const event = {
        id: '0000000000000000000000000000000000000000000000000000000000000000',
        pubkey: '0000000000000000000000000000000000000000000000000000000000000000',
        created_at: 1,
        kind: 1,
        tags: [
          ['p', 'short'],
          ['p', longValue]
        ],
        content: 'content',
        sig: '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
      }

      const record = eventToRecord(event)

      // indexableTags is a flat array for Meilisearch
      assert.strictEqual(record.indexableTags.length, 1)
      assert.strictEqual(record.indexableTags[0], 'p short')
      assert.strictEqual(record.nonIndexableTags.length, 1)
      assert.deepStrictEqual(record.nonIndexableTags[0], ['p', longValue])

      const reconstructed = recordToEvent(record)
      assert.deepStrictEqual(reconstructed.tags, event.tags)
    })
  })
})
