import { tracePublication, PUBLICATION_LOG_MARKER } from '#services/diagnostics/publication.js'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { waitForTaskTerminal } from '#services/db/mdb.js'
import { waitForTaskQueueBarrier } from '#services/db/tasks.js'

describe('definitive Meilisearch task waits', () => {
  it('treats the 60s threshold as soft and keeps polling the same task', async () => {
    const statuses = ['enqueued', 'processing', 'succeeded']
    const inspectedUids = []
    const warnings = []
    const client = {
      async getTask (uid) {
        inspectedUids.push(uid)
        const status = statuses.shift()
        return {
          uid,
          indexUid: 'events',
          type: 'documentAdditionOrUpdate',
          status,
          enqueuedAt: new Date().toISOString()
        }
      }
    }

    const task = await waitForTaskTerminal({
      taskUid: 42,
      indexUid: 'events',
      type: 'documentAdditionOrUpdate'
    }, {
      client,
      softTimeoutMs: 0,
      intervalMs: 1,
      requireSuccess: true,
      logger: {
        warn: (...args) => warnings.push(args),
        log () {},
        error () {}
      }
    })

    assert.equal(task.status, 'succeeded')
    assert.deepEqual(inspectedUids, [42, 42, 42])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0][0], /Continuing to wait for this exact task/)
  })

  it('surfaces an explicit terminal failure without polling another task', async () => {
    const client = {
      async getTask (uid) {
        return {
          uid,
          status: 'failed',
          error: { code: 'invalid_document' }
        }
      }
    }
    await assert.rejects(
      waitForTaskTerminal(9, { client, requireSuccess: true }),
      error => error.name === 'MeiliSearchTaskFailedError' &&
        error.task.uid === 9
    )
  })

  it('can be canceled while fencing a leadership handoff', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      waitForTaskTerminal(11, {
        client: { getTask: async () => ({ uid: 11, status: 'processing' }) },
        signal: controller.signal
      }),
      error => error.name === 'AbortError'
    )
  })

  it('captures and waits only for the newest task visible at handoff', async () => {
    const calls = []
    const client = {
      async getTasks (options) {
        calls.push(['getTasks', options])
        return {
          results: [{ uid: 73, status: 'processing' }]
        }
      }
    }
    const terminal = { uid: 73, status: 'succeeded' }
    const result = await waitForTaskQueueBarrier({
      client,
      waitForTerminal: async (uid, options) => {
        calls.push(['waitForTerminal', uid, options.client])
        return terminal
      }
    })

    assert.equal(result, terminal)
    assert.deepEqual(calls[0], ['getTasks', { limit: 1 }])
    assert.deepEqual(calls[1], ['waitForTerminal', 73, client])
  })
})

it('records terminal task timings without extra task queries or changing failures', async () => {
  for (const status of ['succeeded', 'failed']) {
    let queries = 0
    const logs = []
    const task = { uid: 88, batchUid: 17, indexUid: 'pendingOps', status, enqueuedAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:10Z', finishedAt: '2026-01-01T00:00:11Z' }
    const pending = tracePublication({ id: 'a'.repeat(64), kind: 3560 }, () => waitForTaskTerminal(88, {
      client: { getTask: async () => { queries++; return task } }, requireSuccess: true
    }), { thresholdMs: 0, log: line => logs.push(JSON.parse(line.slice(PUBLICATION_LOG_MARKER.length))) })
    if (status === 'failed') await assert.rejects(pending, { name: 'MeiliSearchTaskFailedError' })
    else assert.equal(await pending, task)
    assert.equal(queries, 1)
    assert.equal(logs[0].tasks[0].queueMs, 10000)
    assert.equal(logs[0].tasks[0].executionMs, 1000)
    assert.equal(logs[0].tasks[0].status, status)
  }
})
