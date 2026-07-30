import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertPm2AppStopped,
  parseArgs,
  run
} from '../../../bin/job/resume-started-workflows.js'

function fakeDependencies (documents, {
  pm2Status = 'stopped'
} = {}) {
  const byKey = new Map(documents.map(document => [document.key, document]))
  const index = {
    async search (_query, options) {
      const started = [...byKey.values()]
        .filter(document => document.phase !== 'queued')
        .sort((left, right) => (left.startedAt || 0) - (right.startedAt || 0))
      return { hits: started.slice(0, options.limit) }
    },
    async getDocument (key) {
      return byKey.get(key)
    }
  }
  const calls = []
  return {
    calls,
    byKey,
    deps: {
      client: {
        index: () => index
      },
      async processPendingWorkflow (workflow) {
        calls.push(['process', workflow.key])
        byKey.delete(workflow.key)
      },
      async waitForTaskQueueBarrier () {
        calls.push(['barrier'])
      },
      async readPm2Processes () {
        return [{
          name: 'web.social-server',
          pm2_env: {
            name: 'web.social-server',
            status: pm2Status
          }
        }]
      }
    }
  }
}

describe('resume-started pending workflow command', () => {
  it('parses an explicit execution and app name', () => {
    assert.deepEqual(
      parseArgs(['--execute', '--pm2-app=relay']),
      { execute: true, pm2App: 'relay' }
    )
    assert.throws(() => parseArgs(['--unknown']), /Unknown option/)
  })

  it('requires every matching PM2 process to be stopped', () => {
    assert.equal(assertPm2AppStopped([{
      name: 'web.social-server',
      pm2_env: { status: 'stopped' }
    }], 'web.social-server'), 1)
    assert.throws(() => assertPm2AppStopped([{
      name: 'web.social-server',
      pm2_env: { status: 'online' }
    }], 'web.social-server'), /still has 1 active/)
    assert.throws(
      () => assertPm2AppStopped([], 'web.social-server'),
      /was not found/
    )
  })

  it('is read-only by default and reports only started workflows', async () => {
    const state = fakeDependencies([
      { key: 'queued', type: 'pruneCheck', phase: 'queued' },
      {
        key: 'prepared',
        type: 'pruneCheck',
        phase: 'prepared',
        startedAt: 1
      }
    ])
    const logger = { log: mock.fn(), error: mock.fn() }

    const result = await run({
      argv: [],
      logger,
      dependencies: state.deps
    })

    assert.equal(result.processed, 0)
    assert.deepEqual(result.workflows.map(workflow => workflow.key), ['prepared'])
    assert.equal(state.byKey.size, 2)
    assert.deepEqual(state.calls, [])
  })

  it('waits for the task barrier and never processes queued work', async () => {
    const state = fakeDependencies([
      { key: 'queued', type: 'deltaUsage', phase: 'queued' },
      {
        key: 'prepared',
        type: 'pruneCheck',
        phase: 'prepared',
        startedAt: 1
      },
      {
        key: 'accounting',
        type: 'deleteEventsWithAccounting',
        phase: 'accounting_applied',
        startedAt: 2
      }
    ])
    const result = await run({
      argv: ['--execute'],
      logger: { log () {}, error () {} },
      dependencies: state.deps
    })

    assert.equal(result.processed, 2)
    assert.deepEqual(state.calls, [
      ['barrier'],
      ['process', 'prepared'],
      ['process', 'accounting']
    ])
    assert.deepEqual([...state.byKey], [[
      'queued',
      { key: 'queued', type: 'deltaUsage', phase: 'queued' }
    ]])
  })

  it('refuses execution before touching workflows while PM2 is active', async () => {
    const state = fakeDependencies([{
      key: 'prepared',
      type: 'pruneCheck',
      phase: 'prepared'
    }], { pm2Status: 'online' })

    await assert.rejects(run({
      argv: ['--execute'],
      logger: { log () {}, error () {} },
      dependencies: state.deps
    }), /still has 1 active/)
    assert.deepEqual(state.calls, [])
  })
})
