import { bytesToBase16, base16ToBytes } from '#helpers/base16.js'

export function bytesToBase64 (uint8Array) {
  if (typeof Buffer === 'function' && typeof Buffer.from === 'function') {
    // Already removes padding
    return Buffer.from(uint8Array).toString('base64url')
  }

  const binaryString = String.fromCharCode.apply(null, uint8Array)
  const base64 = btoa(binaryString)

  return base64
    .replace(/\+/g, '-') // Replace '+' with '-'
    .replace(/\//g, '_') // Replace '/' with '_'
    .replace(/=/g, '')   // Remove padding '='
}

export function base64ToBytes (base64Str) {
  if (typeof Buffer === 'function' && typeof Buffer.from === 'function') {
    // base64url encoding handles both standard and URL-safe base64
    return new Uint8Array(Buffer.from(base64Str, 'base64url'))
  }

  // Convert from URL-safe to standard base64 alphabet
  let standardBase64 = base64Str.replace(/-/g, '+').replace(/_/g, '/')

  // Add back the padding '=' characters if they were removed
  // A valid base64 string's length is always a multiple of 4
  const paddingLength = (4 - (standardBase64.length % 4)) % 4
  standardBase64 += '='.repeat(paddingLength)

  // In a browser, use the built-in atob function.
  const binaryString = atob(standardBase64)
  const len = binaryString.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

export function base16ToBase64 (base16String) {
  const bytes = base16ToBytes(base16String)
  return bytesToBase64(bytes)
}

export function base64ToBase16 (base64Str) {
  const bytes = base64ToBytes(base64Str)
  return bytesToBase16(bytes)
}
