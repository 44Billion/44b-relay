import mdb from '#services/db/mdb.js'

export const TASK_HISTORY_RETENTION_DAYS = 7
export const MAX_TASKS_DELETED_PER_RUN = 5000
export const TASK_COUNT_WARNING_THRESHOLD = 750000
export const FINISHED_TASK_STATUSES = ['succeeded', 'failed', 'canceled']

function checkpoint (signal) {
  signal?.throwIfAborted()
}

export async function run ({
  signal,
  client = mdb,
  now = Date.now(),
  logger = console
} = {}) {
  checkpoint(signal)
  const allTasks = await client.getTasks({ limit: 1 })
  if (allTasks.total > TASK_COUNT_WARNING_THRESHOLD) {
    logger.warn(
      `[MDB] Task history contains ${allTasks.total} tasks; ` +
      `the warning threshold is ${TASK_COUNT_WARNING_THRESHOLD}.`
    )
  }

  checkpoint(signal)
  const retentionCutoff = new Date(
    now - TASK_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()
  const oldTasks = await client.getTasks({
    statuses: FINISHED_TASK_STATUSES,
    beforeEnqueuedAt: retentionCutoff,
    reverse: true,
    limit: MAX_TASKS_DELETED_PER_RUN + 1
  })
  if (oldTasks.total === 0) return { deletedTasks: 0, totalTasks: allTasks.total }

  // The deletion endpoint has no numeric limit. If more than 5,000 tasks are
  // eligible, use the 5,001st oldest timestamp as an exclusive boundary.
  // Equal timestamps may make a run delete fewer tasks, but never more.
  const overflowTask = oldTasks.results[MAX_TASKS_DELETED_PER_RUN]
  if (oldTasks.total > MAX_TASKS_DELETED_PER_RUN && !overflowTask) {
    logger.warn(
      '[MDB] Refusing task cleanup because Meilisearch did not return the ' +
      '5,001st task needed to enforce the deletion limit.'
    )
    return { deletedTasks: 0, totalTasks: allTasks.total }
  }
  const beforeEnqueuedAt = overflowTask?.enqueuedAt || retentionCutoff

  checkpoint(signal)
  const task = await client.deleteTasks({
    statuses: FINISHED_TASK_STATUSES,
    beforeEnqueuedAt
  })
  const deletedTasks = task.details?.deletedTasks ?? 0
  logger.log(
    `[MDB] Deleted ${deletedTasks} finished task(s) older than ` +
    `${beforeEnqueuedAt}; ${oldTasks.total} were eligible before this run.`
  )
  return { deletedTasks, totalTasks: allTasks.total, beforeEnqueuedAt }
}

export default {
  key: 'cleanupMeiliTasks',
  frequency: 60 * 60,
  initialDelay: 10,
  shouldUseLock: true,
  run
}
