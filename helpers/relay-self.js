import { getPublicKey, nip19 } from 'nostr-tools'
import { bytesToBase16 } from '#helpers/base16.js'

export const FALLBACK_RELAY_SELF_SECRET_HEX = '1'.repeat(64)

function normalizeHexSecret (value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) return null
  return trimmed.toLowerCase()
}

function decodeNsecSecret (value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith('nsec1')) return null

  const decoded = nip19.decode(trimmed)
  if (decoded.type !== 'nsec') throw new Error('Expected nsec secret key')
  return bytesToBase16(decoded.data)
}

export function getRelaySelfSecretHex () {
  const configuredValue = process.env.RELAY_SELF_NOSTR_SECRET_KEY || ''
  const normalizedHex = normalizeHexSecret(configuredValue)

  if (normalizedHex) {
    return normalizedHex
  }

  const decodedNsec = decodeNsecSecret(configuredValue)
  if (decodedNsec) {
    return decodedNsec
  }

  return FALLBACK_RELAY_SELF_SECRET_HEX
}

export function getRelaySelfPubkey () {
  const secretHex = getRelaySelfSecretHex()
  const secretBytes = Uint8Array.from(Buffer.from(secretHex, 'hex'))
  return getPublicKey(secretBytes)
}

export function getRelaySelfSecretBytes () {
  return Uint8Array.from(Buffer.from(getRelaySelfSecretHex(), 'hex'))
}
