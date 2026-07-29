import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  FINISHED_TASK_STATUSES,
  MAX_TASKS_DELETED_PER_RUN,
  run,
  TASK_COUNT_WARNING_THRESHOLD
} from '#models/job/jobs/cleanup-meili-tasks.js'

describe('cleanupMeiliTasks', () => {
  it('warns at high volume and uses the 5,001st task as an exclusive boundary', async () => {
    const base = Date.parse('2026-07-01T00:00:00.000Z')
    const oldResults = Array.from(
      { length: MAX_TASKS_DELETED_PER_RUN + 1 },
      (_, index) => ({
        uid: index,
        enqueuedAt: new Date(base + index * 1000).toISOString(),
        status: 'succeeded'
      })
    )
    const deleteTasks = mock.fn(async () => ({
      details: { deletedTasks: MAX_TASKS_DELETED_PER_RUN }
    }))
    let getTasksCall = 0
    const client = {
      async getTasks () {
        getTasksCall++
        if (getTasksCall === 1) {
          return { total: TASK_COUNT_WARNING_THRESHOLD + 1, results: [] }
        }
        return { total: oldResults.length, results: oldResults }
      },
      deleteTasks
    }
    const warnings = []

    const result = await run({
      client,
      now: Date.parse('2026-07-29T00:00:00.000Z'),
      logger: {
        warn: message => warnings.push(message),
        log () {}
      }
    })

    assert.equal(result.deletedTasks, MAX_TASKS_DELETED_PER_RUN)
    assert.equal(warnings.length, 1)
    assert.deepEqual(deleteTasks.mock.calls[0].arguments[0], {
      statuses: FINISHED_TASK_STATUSES,
      beforeEnqueuedAt: oldResults[MAX_TASKS_DELETED_PER_RUN].enqueuedAt
    })
  })

  it('does nothing when no finished task is older than the retention window', async () => {
    const deleteTasks = mock.fn()
    const client = {
      getTasks: mock.fn(async options => options.limit === 1
        ? { total: 10, results: [] }
        : { total: 0, results: [] }),
      deleteTasks
    }
    assert.deepEqual(await run({
      client,
      logger: { warn () {}, log () {} }
    }), {
      deletedTasks: 0,
      totalTasks: 10
    })
    assert.equal(deleteTasks.mock.callCount(), 0)
  })

  it('is idempotent after the eligible history has been deleted', async () => {
    const deleteTasks = mock.fn(async () => ({
      details: { deletedTasks: 2 }
    }))
    let oldHistoryExists = true
    const client = {
      async getTasks (options) {
        if (options.limit === 1) return { total: oldHistoryExists ? 12 : 10, results: [] }
        return oldHistoryExists
          ? {
              total: 2,
              results: [
                { uid: 1, enqueuedAt: '2026-07-01T00:00:00.000Z' },
                { uid: 2, enqueuedAt: '2026-07-01T00:00:01.000Z' }
              ]
            }
          : { total: 0, results: [] }
      },
      async deleteTasks (options) {
        const result = await deleteTasks(options)
        oldHistoryExists = false
        return result
      }
    }
    const logger = { warn () {}, log () {} }

    assert.equal((await run({ client, logger })).deletedTasks, 2)
    assert.equal((await run({ client, logger })).deletedTasks, 0)
    assert.equal(deleteTasks.mock.callCount(), 1)
  })
})
