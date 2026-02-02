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

export function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
