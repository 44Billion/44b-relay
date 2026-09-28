import { it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { tracePublication, publicationStage, publicationResult, publicationDatabaseCall, publicationTask, PUBLICATION_LOG_MARKER } from '#services/diagnostics/publication.js'

const event = { id: 'a'.repeat(64), kind: 3560, content: 'private ciphertext', tags: [['secret', 'value']], pubkey: 'secret author' }
const parse = line => JSON.parse(line.slice(PUBLICATION_LOG_MARKER.length))

it('isolates concurrent publications, measures original promises and excludes message data', async () => {
  const logs = []
  const options = { thresholdMs: 0, log: line => logs.push(line) }
  await Promise.all([1, 2].map(id => tracePublication({ ...event, id: String(id).repeat(64) }, async () => {
    await publicationStage('persistence', async () => {
      await publicationDatabaseCall(delay(id === 1 ? 20 : 1), { index: 'pendingOps', method: 'addDocuments', started: performance.now() })
      publicationTask({ uid: id, indexUid: 'pendingOps', status: 'succeeded', enqueuedAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:10Z', finishedAt: '2026-01-01T00:00:11Z', error: 'sensitive' }, { waitMs: 11000, communicationFailures: 0 })
    })
    publicationResult(true)
  }, options)))
  assert.equal(logs.length, 2)
  for (const row of logs.map(parse)) {
    assert.equal(row.tasks[0].uid, Number(row.eventId[0]))
    assert.equal(row.tasks[0].queueMs, 10000)
    assert.equal(row.tasks[0].executionMs, 1000)
    assert.equal(row.database.length, 1)
    assert.equal(row.accepted, true)
    assert.ok(row.stages.persistence > 0)
  }
  assert.doesNotMatch(logs.join(''), /private ciphertext|secret|sensitive|pubkey|content|tags/)
})

it('keeps outcomes unchanged on failures, synchronous stages and failing logger', async () => {
  const failure = new Error('original error')
  const logs = []
  await assert.rejects(tracePublication(event, () => publicationStage('persistence', () => {
    throw failure
  }), { thresholdMs: 0, log: line => logs.push(parse(line)) }), error => error === failure)
  assert.ok(logs[0].stages.persistence >= 0)
  assert.equal(await tracePublication(event, () => {
    assert.equal(publicationStage('sendOk', () => 42), 42)
    return 7
  }, { thresholdMs: 0, log: () => { throw new Error('logging failed') } }), 7)
  await assert.rejects(tracePublication(event, () => publicationDatabaseCall(Promise.reject(failure), { index: 'events', method: 'search', started: performance.now() }), { thresholdMs: 0, log: line => logs.push(parse(line)) }), error => error === failure)
  assert.equal(logs.at(-1).database[0].success, false)
})

it('logs only above threshold and bounds database/task details', async () => {
  const logs = []
  await tracePublication(event, () => {}, { thresholdMs: 100000, log: line => logs.push(line) })
  assert.equal(logs.length, 0)
  await tracePublication(event, async () => {
    for (let i = 0; i < 40; i++) {
      publicationTask({ uid: i }, { waitMs: 0, communicationFailures: 0 })
      await publicationDatabaseCall(Promise.resolve(), { index: 'events', method: 'search', started: performance.now() })
    }
  }, { thresholdMs: 0, log: line => logs.push(parse(line)) })
  assert.equal(logs[0].tasks.length, 32)
  assert.equal(logs[0].database.length, 32)
  assert.deepEqual(logs[0].omitted, { database: 8, tasks: 8 })
})
