import { Buffer } from 'buffer'
import { ConservativeCountMin } from 'sketch-oxide-node'
import mdb from '#services/db/mdb.js'
import { queueOps } from '#services/event/maintainer/mdb/index.js'
import { compressAsync, decompressAsync } from '#helpers/buffer.js'
import { getIpScore } from './ip-activity.js'

const SPAM_SCORE_THRESHOLD = 1000
const SKETCH_EPSILON = 0.001
const SKETCH_DELTA = 0.99
const WINDOW_DURATION = 1000 * 60 * 60 * 24 // 24 Hours

function createSketch () {
  return new ConservativeCountMin(SKETCH_EPSILON, 1 - SKETCH_DELTA)
}

const SKETCH_KEYS = {
  current: 'event-req-sketch-current',
  previous: 'event-req-sketch-previous',
  meta: 'event-req-sketch-meta'
}

// Local cache (flushed every 60s)
let localSketch = createSketch()
let hasLocalUpdates = false

// Global cache (read-only, refreshed lazily)
let cachedGlobalCurrent = createSketch()
let cachedGlobalPrevious = createSketch()
let lastCacheUpdate = 0
let isFetchingCache = false
const CACHE_TTL = 1000 * 60 * 15 // 15 minutes

export function trackRequestedEvents ({ refs, ip }) {
  if (!ip || !refs || refs.length === 0) return
  if (getIpScore(ip) > SPAM_SCORE_THRESHOLD) return

  for (const ref of refs) {
    localSketch.update(Buffer.from(ref))
  }
  hasLocalUpdates = true
}

export function getEventRequestScore (ref) {
  if (!ref) return 0

  // Lazy refresh
  if (!isFetchingCache && Date.now() - lastCacheUpdate > CACHE_TTL) {
    isFetchingCache = true
    refreshGlobalSketches().finally(() => { isFetchingCache = false })
  }

  const buf = Buffer.from(ref)
  return localSketch.estimate(buf) + cachedGlobalCurrent.estimate(buf) + cachedGlobalPrevious.estimate(buf)
}

async function refreshGlobalSketches () {
  try {
    const [docCurr, docPrev] = await Promise.all([
      mdb.index('ipActivities').getDocument(SKETCH_KEYS.current).catch(() => null),
      mdb.index('ipActivities').getDocument(SKETCH_KEYS.previous).catch(() => null)
    ])

    if (docCurr) cachedGlobalCurrent = ConservativeCountMin.deserialize(await decompressAsync(Buffer.from(docCurr.data, 'base64url')))
    if (docPrev) cachedGlobalPrevious = ConservativeCountMin.deserialize(await decompressAsync(Buffer.from(docPrev.data, 'base64url')))

    lastCacheUpdate = Date.now()
  } catch (err) {
    console.error('Failed to refresh global event request sketches', err)
  }
}

// ----------------------------------------------------------------------------
// Flush Logic
// ----------------------------------------------------------------------------

export async function flushRequestedEventsToMDB () {
  if (!hasLocalUpdates) return

  // Snapshot and reset
  const currentSketch = localSketch
  localSketch = createSketch()
  hasLocalUpdates = false

  const compressedSketch = await compressAsync(currentSketch.serialize())

  const ops = [{
    type: 'mergeSketch',
    data: { key: SKETCH_KEYS.current, sketch: compressedSketch.toString('base64url') }
  }]

  try {
    await queueOps(ops)
  } catch (err) {
    console.error('Failed to queue event request sketch ops', err)
  }
}

// ----------------------------------------------------------------------------
// Rotation + Cleanup Helpers (used by the cleanup job)
// ----------------------------------------------------------------------------

export async function loadAndMaybeRotateSketches () {
  let sketchCurrent, sketchPrevious

  const [docCurr, docPrev, docMeta] = await Promise.all([
    mdb.index('ipActivities').getDocument(SKETCH_KEYS.current).catch(() => null),
    mdb.index('ipActivities').getDocument(SKETCH_KEYS.previous).catch(() => null),
    mdb.index('ipActivities').getDocument(SKETCH_KEYS.meta).catch(() => ({ lastRotation: 0 }))
  ])

  sketchCurrent = docCurr
    ? ConservativeCountMin.deserialize(await decompressAsync(Buffer.from(docCurr.data, 'base64url')))
    : createSketch()

  sketchPrevious = docPrev
    ? ConservativeCountMin.deserialize(await decompressAsync(Buffer.from(docPrev.data, 'base64url')))
    : createSketch()

  // Rotation logic (sliding window)
  const lastRotation = docMeta.lastRotation || 0
  const now = Date.now()

  if (now - lastRotation > WINDOW_DURATION) {
    console.log('Rotating event request sketch window')
    const prevSerialized = (await compressAsync(sketchCurrent.serialize())).toString('base64url')
    const newSerialized = (await compressAsync(createSketch().serialize())).toString('base64url')

    await Promise.all([
      mdb.index('ipActivities').addDocuments([{ key: SKETCH_KEYS.previous, data: prevSerialized }]),
      mdb.index('ipActivities').addDocuments([{ key: SKETCH_KEYS.current, data: newSerialized }]),
      mdb.index('ipActivities').addDocuments([{ key: SKETCH_KEYS.meta, lastRotation: now }])
    ])

    sketchPrevious = sketchCurrent
    sketchCurrent = createSketch()
  }

  return { sketchCurrent, sketchPrevious }
}
