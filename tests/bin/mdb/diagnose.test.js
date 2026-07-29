import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeDiagnostics,
  durationMs,
  parseArgs,
  run
} from '../../../bin/mdb/diagnose.js'

describe('mdb diagnostics analysis', () => {
  it('explains the old-version and facet-search pattern from production', () => {
    const slowBatches = [
      makeBatch({
        uid: 7525766,
        durationMs: 10_557,
        phase: 'processing tasks > indexing > post processing facets > facet search',
        phaseDuration: '10.40s'
      }),
      makeBatch({
        uid: 7525701,
        durationMs: 10_397,
        phase: 'processing tasks > indexing > post processing facets > facet search',
        phaseDuration: '10.23s'
      }),
      makeBatch({
        uid: 7525747,
        durationMs: 10_059,
        phase: 'processing tasks > indexing > post processing facets > facet search',
        phaseDuration: '9.84s'
      })
    ]
    const analysis = analyzeDiagnostics(makeDiagnostics({
      version: '1.35.1',
      scannedBatches: slowBatches,
      slowBatches,
      slowBatchCount: slowBatches.length
    }))

    assert.equal(analysis.status, 'warning')
    assert.ok(analysis.findings.some(finding =>
      finding.code === 'version' &&
      finding.message.includes('older than')
    ))
    assert.ok(analysis.findings.some(finding =>
      finding.code === 'batch-duration' &&
      finding.message.includes('10.6s')
    ))
    assert.ok(analysis.findings.some(finding =>
      finding.code === 'dominant-phase' &&
      finding.message.includes('"facet search"') &&
      finding.message.includes('98.5%')
    ))
    assert.ok(analysis.findings.some(finding =>
      finding.code === 'write-congestion' &&
      finding.level === 'ok'
    ))
    assert.ok(analysis.nextSteps.some(step =>
      step.includes('npm run mdb:upgrade')
    ))
  })

  it('marks a task older than the soft timeout as critical and gives its command', () => {
    const analysis = analyzeDiagnostics(makeDiagnostics({
      checkedAt: '2026-07-29T18:02:00.000Z',
      queue: {
        total: 3,
        oldest: {
          uid: 8500001,
          status: 'processing',
          enqueuedAt: '2026-07-29T18:00:00.000Z'
        }
      }
    }))

    assert.equal(analysis.status, 'critical')
    assert.ok(analysis.findings.some(finding =>
      finding.code === 'queue' &&
      finding.message.includes('2m 0s')
    ))
    assert.ok(analysis.nextSteps.some(step =>
      step.includes('--task=8500001')
    ))
  })

  it('reports no immediate action for a healthy current and fast instance', () => {
    const analysis = analyzeDiagnostics(makeDiagnostics())

    assert.equal(analysis.status, 'ok')
    assert.match(analysis.headline, /No immediate/)
    assert.equal(analysis.nextSteps.length, 1)
    assert.match(analysis.nextSteps[0], /No immediate action/)
  })

  it('parses durations and the concise output option', () => {
    assert.equal(durationMs('PT1H2M3.5S'), 3_723_500)
    assert.equal(durationMs('not-a-duration'), null)
    assert.equal(parseArgs(['--summary-only']).summaryOnly, true)
  })

  it('prints only analysis in summary-only mode while returning full data', async () => {
    const output = []
    const result = await run({
      argv: ['--summary-only'],
      Client: FakeClient,
      logger: { log: value => output.push(value) }
    })

    const printed = JSON.parse(output[0])
    assert.equal(printed.status, 'ok')
    assert.equal(printed.version, undefined)
    assert.equal(result.version.pkgVersion, '1.51.0')
    assert.equal(result.taskHistory.total, 42)
    assert.ok(result.analysis)
  })
})

function makeDiagnostics (overrides = {}) {
  const {
    version = '1.51.0',
    ...diagnosticOverrides
  } = overrides
  return {
    checkedAt: '2026-07-29T18:00:00.000Z',
    version: { pkgVersion: version },
    health: { status: 'available' },
    queue: { total: 0, oldest: null },
    taskHistory: { total: 1000 },
    recentBatchesScanned: 200,
    slowBatchCount: 0,
    slowBatches: [],
    scannedBatches: [],
    ...diagnosticOverrides
  }
}

function makeBatch ({
  uid,
  durationMs,
  phase,
  phaseDuration,
  blockingRatio = 0
}) {
  return {
    uid,
    durationMs,
    stats: {
      totalNbTasks: 1,
      status: { succeeded: 1 },
      types: { documentAdditionOrUpdate: 1 },
      indexUids: { events: 1 },
      progressTrace: {
        'processing tasks': `${(durationMs / 1000).toFixed(2)}s`,
        [phase]: phaseDuration
      },
      writeChannelCongestion: {
        blocking_ratio: blockingRatio
      }
    }
  }
}

class FakeClient {
  constructor () {
    this.tasks = {
      getTasks: async options => options.statuses
        ? { total: 0, results: [] }
        : { total: 42, results: [{ uid: 42 }] }
    }
    this.batches = {
      getBatches: async () => ({ total: 0, results: [] })
    }
  }

  async getVersion () {
    return { pkgVersion: '1.51.0' }
  }

  async health () {
    return { status: 'available' }
  }
}
