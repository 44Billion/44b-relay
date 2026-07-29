export function maybeUnref (timer) {
  if (typeof window === 'undefined') timer.unref()
  return timer
}

export function setTimer (fn, callback, delay) {
  if (typeof callback !== 'function') {
    delay = callback
    callback = fn
    fn = setTimeout
  }
  return maybeUnref(fn(callback, delay))
}

export function wait (ms, { signal } = {}) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms))
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done () {
      signal.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted () {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      reject(signal.reason)
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}
