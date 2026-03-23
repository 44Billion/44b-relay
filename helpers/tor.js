import { maybeUnref } from '#helpers/timer.js'

const torExitNodes = new Set()
const REFRESH_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

let lastFetchMs = 0

async function refreshTorExitNodes () {
  try {
    const response = await fetch('https://check.torproject.org/torbulkexitlist')
    if (!response.ok) return
    const text = await response.text()
    torExitNodes.clear()
    for (const line of text.split('\n')) {
      const ip = line.trim()
      if (ip && !ip.startsWith('#')) torExitNodes.add(ip)
    }
    lastFetchMs = Date.now()
  } catch {
    // Best-effort: TOR detection is non-critical
  }
}

function isTorExitNode (ip) {
  if (Date.now() - lastFetchMs > REFRESH_INTERVAL_MS) {
    refreshTorExitNodes() // fire and forget
  }
  return torExitNodes.has(ip)
}

// Initial fetch
refreshTorExitNodes()
maybeUnref(setInterval(refreshTorExitNodes, REFRESH_INTERVAL_MS))

export { isTorExitNode }
