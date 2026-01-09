export { Relay } from 'nostr-tools/relay'

export function isValidRelayUrl (url) {
  try {
    const urlObject = new URL(url)
    const { protocol, hostname, pathname } = urlObject

    // Must be a secure websocket protocol
    if (protocol !== 'wss:') {
      return false
    }

    // Filter out non-public relays
    if (hostname === 'localhost' || hostname.endsWith('.local') || hostname === '[::1]') {
      return false
    }
    if (/^(127\.|10\.|192\.168\.)/.test(hostname)) {
      return false
    }

    // Hostname must be a valid FQDN (contains a dot) or an IP address.
    // This filters out single-label hostnames like `wss://example/`
    if (!hostname.includes('.') && !hostname.startsWith('[')) {
      return false
    }

    // Filter out .onion addresses
    if (hostname.endsWith('.onion')) {
      return false
    }

    // Filter out URLs with npub1 or nprofile
    if (url.includes('npub1') || url.includes('nprofile')) {
      return false
    }

    // Filter out aggregator URLs that contain other URL schemes
    if (pathname.includes('://')) {
      return false
    }

    return true
  } catch (_err) {
    // Malformed URL
    return false
  }
}
