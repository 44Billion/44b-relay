import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

describe('helpers/relay-self', () => {
  let originalSecretKey

  beforeEach(() => {
    originalSecretKey = process.env.RELAY_SELF_NOSTR_SECRET_KEY
  })

  afterEach(() => {
    if (originalSecretKey !== undefined) process.env.RELAY_SELF_NOSTR_SECRET_KEY = originalSecretKey
    else delete process.env.RELAY_SELF_NOSTR_SECRET_KEY
  })

  async function loadFresh () {
    // Re-import each time is fine because the functions read env at call time
    return await import('#helpers/relay-self.js')
  }

  it('should derive pubkey from a valid hex secret key', async () => {
    // Known test vector: secret = '1'.repeat(64)
    process.env.RELAY_SELF_NOSTR_SECRET_KEY = '1'.repeat(64)

    const mod = await loadFresh()
    const pubkey = mod.getRelaySelfPubkey()
    assert.equal(typeof pubkey, 'string')
    assert.equal(pubkey.length, 64)
    assert.equal(pubkey, '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa')
  })

  it('should decode nsec-encoded secret key', async () => {
    // nsec for secret '1'.repeat(64) - we generate it dynamically
    const { nip19 } = await import('nostr-tools')
    const secretBytes = Uint8Array.from(Buffer.from('1'.repeat(64), 'hex'))
    const nsec = nip19.nsecEncode(secretBytes)

    process.env.RELAY_SELF_NOSTR_SECRET_KEY = nsec

    const mod = await loadFresh()
    const pubkey = mod.getRelaySelfPubkey()
    assert.equal(pubkey, '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa')
  })

  it('should fallback to all-1s secret when env var is empty', async () => {
    process.env.RELAY_SELF_NOSTR_SECRET_KEY = ''

    const mod = await loadFresh()
    const hex = mod.getRelaySelfSecretHex()
    assert.equal(hex, '1'.repeat(64))

    const pubkey = mod.getRelaySelfPubkey()
    assert.equal(pubkey, '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa')
  })

  it('should fallback to all-1s secret when env var is missing', async () => {
    delete process.env.RELAY_SELF_NOSTR_SECRET_KEY

    const mod = await loadFresh()
    const hex = mod.getRelaySelfSecretHex()
    assert.equal(hex, '1'.repeat(64))
  })

  it('should return Uint8Array secret bytes', async () => {
    process.env.RELAY_SELF_NOSTR_SECRET_KEY = '1'.repeat(64)

    const mod = await loadFresh()
    const bytes = mod.getRelaySelfSecretBytes()
    assert.ok(bytes instanceof Uint8Array)
    assert.equal(bytes.length, 32)
  })
})
