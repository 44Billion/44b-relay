import { getPublicKey } from 'libp2r2p/key'
import { nsecDecode } from 'libp2r2p/nip19'

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

  return nsecDecode(trimmed)
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
