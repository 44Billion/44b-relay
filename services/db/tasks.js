import mdb, {
  TERMINAL_TASK_STATUSES,
  waitForTaskTerminal
} from './mdb.js'

// A new IPC leader waits for the newest task visible at election time. Since
// Meilisearch processes tasks in order, this fences mutations submitted by the
// previous leader without waiting for tasks created afterwards.
export async function waitForTaskQueueBarrier ({
  signal,
  client = mdb,
  waitForTerminal = waitForTaskTerminal
} = {}) {
  const { results } = await client.getTasks({ limit: 1 })
  const newest = results[0]
  if (!newest || TERMINAL_TASK_STATUSES.has(newest.status)) return newest || null
  return waitForTerminal(newest.uid, { signal, client })
}

export { TERMINAL_TASK_STATUSES, waitForTaskTerminal }
