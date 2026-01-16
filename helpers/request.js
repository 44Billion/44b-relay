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

function getIp (req) {
  return (req.ip ??= req.headers['x-forwarded-for']?.split?.(', ')?.[0]?.trim?.() ?? req.socket.remoteAddress ?? 'all')
}

export {
  rateLimitByKey,
  getIp
}
