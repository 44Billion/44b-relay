import { maybeUnref } from '#helpers/timer.js'

const rateLimitBucket = {}
function rateLimitByKey ({
  key,
  reqsPerWindow,
  windowMinutes,
  windowSeconds = (windowMinutes && (windowMinutes * 60)) || (3 * 60)
}) {
  if (!key) {
    console.log('rate limit key is empty')
    return { isRateLimited: false, nextWindow: new Date() }
  }
  if (!rateLimitBucket[key]) {
    const startMs = Date.now()
    const windowMs = 1000 * windowSeconds
    rateLimitBucket[key] = {
      nextWindow: new Date(startMs + windowMs),
      maxReqs: reqsPerWindow
    }
    maybeUnref(setTimeout(() => delete rateLimitBucket[key], windowMs))
  }
  const isRateLimited = rateLimitBucket[key].maxReqs-- <= 0
  return { isRateLimited, nextWindow: rateLimitBucket[key].nextWindow }
}

// Refill continuously, as clients do. Rejected requests never create debt.
const messageBuckets = new Map()
export function rateLimitTokenBucket ({ key, capacity, windowMs }) {
  const now = Date.now()
  let bucket = messageBuckets.get(key)
  if (!bucket) {
    bucket = { tokens: capacity, updatedAt: now, timer: null }
    messageBuckets.set(key, bucket)
  }
  bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.updatedAt) * capacity / windowMs)
  bucket.updatedAt = now
  const isRateLimited = bucket.tokens < 1
  if (!isRateLimited) bucket.tokens--
  // After an idle refill period there is no state left to remember.
  clearTimeout(bucket.timer)
  bucket.timer = maybeUnref(setTimeout(() => messageBuckets.delete(key), windowMs))
  return { isRateLimited, nextWindow: new Date(now + Math.ceil(Math.max(0, 1 - bucket.tokens) * windowMs / capacity)) }
}

function getIp (req) {
  return (req.ip ??= req.headers['x-forwarded-for']?.split?.(', ')?.[0]?.trim?.() ?? req.socket.remoteAddress ?? 'all')
}

export {
  rateLimitByKey,
  getIp
}
