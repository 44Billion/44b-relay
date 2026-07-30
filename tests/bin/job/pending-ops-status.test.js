import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeSnapshots,
  collectSnapshot,
  parseArgs,
  run
} from '../../../bin/job/pending-ops-status.js'

describe('pendingOps status', () => {
  it('parses snapshot and bounded watch options', () => {
    assert.deepEqual(parseArgs([]), {
      watchSeconds: 0,
      intervalSeconds: 10,
      intervalWasExplicit: false
    })
    assert.deepEqual(parseArgs(['--watch=120', '--interval=10']), {
      watchSeconds: 120,
      intervalSeconds: 10,
      intervalWasExplicit: true
    })
    assert.throws(
      () => parseArgs(['--interval=10']),
      /requires --watch/
    )
    assert.throws(
      () => parseArgs(['--watch=1.5']),
      /must be an integer/
    )
  })

  it('collects exact depth, phases and workflow step without full data', async () => {
    const calls = []
    const client = makeClient([{
      count: 3,
      phases: { queued: 2, prepared: 1 },
      oldest: makeOp({
        key: 'oldest',
        step: 7,
        createdAt: Date.parse('2026-07-30T12:00:00.000Z')
      }),
      workflow: makeOp({
        key: 'workflow',
        phase: 'prepared',
        createdAt: Date.parse('2026-07-30T12:00:10.000Z'),
        startedAt: Date.parse('2026-07-30T12:00:20.000Z')
      })
    }], calls)

    const snapshot = await collectSnapshot({
      client,
      clock: () => Date.parse('2026-07-30T12:01:00.000Z')
    })

    assert.equal(snapshot.count, 3)
    assert.deepEqual(snapshot.phases, { prepared: 1, queued: 2 })
    assert.equal(snapshot.oldest.key, 'oldest')
    assert.equal(snapshot.oldest.step, 7)
    assert.equal(snapshot.oldest.queuedForMs, 60_000)
    assert.equal(snapshot.oldestStartedWorkflow.key, 'workflow')
    assert.equal(snapshot.oldestStartedWorkflow.startedForMs, 40_000)
    assert.equal(calls.some(call =>
      call.options.attributesToRetrieve.includes('data')
    ), false)
    assert.equal(calls.every(call =>
      call.options.attributesToRetrieve.includes('data.step')
    ), true)
    assert.ok(calls.some(call => call.options.filter))
  })

  it('reports a growing queue while recognizing head progress', () => {
    const analysis = analyzeSnapshots([
      makeSnapshot({
        checkedAt: '2026-07-30T12:00:00.000Z',
        count: 10,
        oldest: operationSummary('a', 20_000)
      }),
      makeSnapshot({
        checkedAt: '2026-07-30T12:01:00.000Z',
        count: 25,
        oldest: operationSummary('b', 15_000)
      })
    ])

    assert.equal(analysis.status, 'warning')
    assert.equal(analysis.trend.countDelta, 15)
    assert.equal(analysis.trend.queuedCountDelta, 15)
    assert.equal(analysis.trend.headChanges, 1)
    assert.ok(analysis.findings.some(finding =>
      finding.code === 'trend' &&
      finding.message.includes('15 total') &&
      finding.message.includes('15 queued') &&
      finding.message.includes('head changed 1')
    ))
  })

  it('reports the same aging head as a likely blocker', () => {
    const analysis = analyzeSnapshots([
      makeSnapshot({
        checkedAt: '2026-07-30T12:00:00.000Z',
        count: 8,
        oldest: operationSummary('blocked', 120_000)
      }),
      makeSnapshot({
        checkedAt: '2026-07-30T12:02:00.000Z',
        count: 12,
        oldest: operationSummary('blocked', 240_000)
      })
    ])

    assert.equal(analysis.status, 'critical')
    assert.equal(analysis.trend.sameOldestThroughout, true)
    assert.ok(analysis.findings.some(finding =>
      finding.code === 'trend' &&
      finding.message.includes('same operation blocked')
    ))
    assert.ok(analysis.nextSteps.some(step =>
      step.includes('blocked') && step.includes('before resetting')
    ))
  })

  it('recognizes phase or step changes as progress for the same head', () => {
    const analysis = analyzeSnapshots([
      makeSnapshot({
        checkedAt: '2026-07-30T12:00:00.000Z',
        count: 8,
        oldest: operationSummary('advancing', 120_000, {
          type: 'pruneCheck',
          step: 6
        })
      }),
      makeSnapshot({
        checkedAt: '2026-07-30T12:02:00.000Z',
        count: 12,
        oldest: operationSummary('advancing', 240_000, {
          type: 'pruneCheck',
          phase: 'prepared',
          step: 7
        }),
        oldestStartedWorkflow: {
          ...operationSummary('advancing', 240_000, {
            type: 'pruneCheck',
            phase: 'prepared',
            step: 7
          }),
          startedForMs: 360_000
        }
      })
    ])

    assert.equal(analysis.status, 'warning')
    assert.equal(analysis.trend.sameOldestThroughout, true)
    assert.equal(analysis.trend.headProgressChanges, 1)
    assert.ok(analysis.findings.some(finding =>
      finding.code === 'trend' &&
      finding.message.includes('advanced phase or step')
    ))
    assert.equal(analysis.nextSteps.some(step =>
      step.includes('before resetting')
    ), false)
  })

  it('flags an old started workflow because it is processed with priority', () => {
    const analysis = analyzeSnapshots([
      makeSnapshot({
        checkedAt: '2026-07-30T12:00:00.000Z',
        count: 3,
        oldest: operationSummary('queued', 10_000),
        oldestStartedWorkflow: {
          ...operationSummary('workflow', 400_000),
          type: 'deleteEventsWithAccounting',
          phase: 'events_deleted',
          startedForMs: 360_000
        }
      })
    ])

    assert.equal(analysis.status, 'critical')
    assert.ok(analysis.findings.some(finding =>
      finding.code === 'started-workflow' &&
      finding.message.includes('workflow') &&
      finding.message.includes('6m 0s')
    ))
    assert.ok(analysis.nextSteps.some(step =>
      step.includes('prioritized ahead')
    ))
  })

  it('reports a queue that drains as healthy', () => {
    const analysis = analyzeSnapshots([
      makeSnapshot({
        checkedAt: '2026-07-30T12:00:00.000Z',
        count: 20,
        oldest: operationSummary('a', 20_000)
      }),
      makeSnapshot({
        checkedAt: '2026-07-30T12:01:00.000Z',
        count: 0,
        oldest: null
      })
    ])

    assert.equal(analysis.status, 'ok')
    assert.equal(analysis.trend.countDelta, -20)
    assert.ok(analysis.findings.some(finding =>
      finding.code === 'trend' && finding.message.includes('drained')
    ))
  })

  it('samples through run and prints progress before the final analysis', async () => {
    const output = []
    const progress = []
    let currentTime = Date.parse('2026-07-30T12:00:00.000Z')
    const sequences = [
      {
        count: 4,
        phases: { queued: 4 },
        oldest: makeOp({ key: 'a', createdAt: currentTime - 10_000 })
      },
      {
        count: 2,
        phases: { queued: 2 },
        oldest: makeOp({ key: 'b', createdAt: currentTime })
      },
      {
        count: 0,
        phases: {},
        oldest: null
      }
    ]
    const Client = class {
      constructor () {
        return makeClient(sequences)
      }
    }
    const result = await run({
      argv: ['--watch=20', '--interval=10'],
      Client,
      clock: () => currentTime,
      wait: async milliseconds => {
        currentTime += milliseconds
      },
      logger: {
        log: value => output.push(value),
        error: value => progress.push(value)
      }
    })

    assert.equal(result.samples.length, 3)
    assert.equal(result.analysis.status, 'info')
    assert.equal(progress.length, 3)
    assert.match(progress[0], /^\[pending-ops\]/)
    assert.equal(output.length, 1)
    assert.equal(JSON.parse(output[0]).analysis.trend.countDelta, -4)
  })
})

function makeOp ({
  key = 'op',
  type = 'patchDocumentIfExists',
  phase = 'queued',
  createdAt = 0,
  startedAt,
  step
} = {}) {
  return {
    key,
    type,
    phase,
    createdAt,
    ...(step === undefined ? {} : { data: { step } }),
    ...(startedAt === undefined ? {} : { startedAt })
  }
}

function operationSummary (key, queuedForMs, {
  type = 'patchDocumentIfExists',
  phase = 'queued',
  step = null
} = {}) {
  return {
    key,
    type,
    phase,
    step,
    queuedForMs,
    startedForMs: null
  }
}

function makeSnapshot ({
  checkedAt,
  count,
  oldest,
  oldestStartedWorkflow = null
}) {
  return {
    checkedAt,
    count,
    isIndexing: false,
    phases: count ? { queued: count } : {},
    oldest,
    oldestStartedWorkflow
  }
}

function makeClient (sequences, calls = []) {
  let sampleIndex = -1
  let current
  return {
    index (uid) {
      assert.equal(uid, 'pendingOps')
      return {
        async getStats () {
          sampleIndex++
          current = sequences[Math.min(sampleIndex, sequences.length - 1)]
          return {
            numberOfDocuments: current.count,
            isIndexing: false
          }
        },
        async search (_query, options) {
          calls.push({ options })
          if (options.filter) {
            return { hits: current.workflow ? [current.workflow] : [] }
          }
          return {
            hits: current.oldest ? [current.oldest] : [],
            facetDistribution: { phase: current.phases }
          }
        }
      }
    }
  }
}
