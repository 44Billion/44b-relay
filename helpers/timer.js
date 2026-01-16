export function maybeUnref (timer) {
  if (typeof window === 'undefined') timer.unref()
  return timer
}

export function setTimer (callback, delay) {
  return maybeUnref(setTimeout(callback, delay))
}

export function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
