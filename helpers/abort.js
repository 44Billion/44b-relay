export function checkpoint (signal) {
  signal?.throwIfAborted()
}

export function rethrowAbort (error) {
  if (error?.name === 'AbortError') throw error
}
