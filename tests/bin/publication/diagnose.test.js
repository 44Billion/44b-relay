import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { collect, writeReport, parseOptions, parseRecord, DEFAULT_OUTPUT, run } from '../../../bin/publication/diagnose.js'
import { PUBLICATION_LOG_MARKER } from '#services/diagnostics/publication.js'

const now = Date.parse('2026-09-28T20:30:00Z')
const record = (id = 1, extra = {}) => ({ version: 1, at: '2026-09-28T20:29:00Z', completedAt: '2026-09-28T20:29:12Z', eventId: String(id).repeat(64), pid: id, elapsedMs: 12000, accepted: true, stages: { persistence: 11800, broadcast: 100 }, database: [], tasks: [{ uid: id, queueMs: 10000, executionMs: 1500 }], ...extra })
const line = (id, extra) => `2026-09-28T20:29:12: ${PUBLICATION_LOG_MARKER}${JSON.stringify(record(id, extra))}\n`

async function fixture (t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'publication-diagnostic-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const processes = [0, 1].map(id => ({
    name: 'web.social-server', pm2_env: {
      pm_out_log_path: path.join(dir, `web.social-server-out-${id}.log`),
      pm_err_log_path: path.join(dir, `web.social-server-error-${id}.log`)
    }
  }))
  const put = async (name, data) => {
    const file = path.join(dir, name)
    await writeFile(file, data)
    await utimes(file, new Date(now), new Date(now))
    return file
  }
  return { dir, processes, put }
}

it('collects both workers and retained gzip/plain rotations, filters time/noise and deduplicates', async t => {
  const { processes, put } = await fixture(t)
  await put('web.social-server-out-0.log', 'noise\n' + line(1) + line(9, { completedAt: '2026-09-27T00:00:00Z' }) + PUBLICATION_LOG_MARKER + 'broken\n')
  await put('web.social-server-out-1.log', line(2))
  await put('web.social-server-out-4__2026-09-28_20-20-00.log.gz', gzipSync(line(3)))
  await put('web.social-server-error-0.log.1', line(1))
  await put('web.social-server-out-1__2026-09-28.log', line(4))
  await put('other-app-out-0.log', line(5))
  const report = await collect({ processes, app: 'web.social-server', sinceMs: 1800000, now })
  assert.equal(report.instances, 2)
  assert.equal(report.records.length, 4)
  assert.equal(report.summary.maxTaskQueueMs, 10000)
  assert.equal(report.summary.maxTaskExecutionMs, 1500)
  assert.equal(report.summary.stages.persistence.totalMs, 47200)
  assert.match(report.warnings.join(), /1 malformed/)
})

it('handles PM2 JSON wrappers and exports only approved fields', () => {
  const input = JSON.stringify({ message: line(1, { content: 'private', author: 'hidden', stages: { persistence: 2, query: 'secret' }, database: [{ index: 'events', method: 'search', query: 'secret' }] }) })
  const parsed = parseRecord(input)
  assert.equal(parsed.pid, 1)
  assert.doesNotMatch(JSON.stringify(parsed), /private|hidden|secret|query/)
})

it('handles chunk boundaries, oversized noise and truncated gzip with explicit warnings', async t => {
  const { processes, put } = await fixture(t)
  await put('web.social-server-out-0.log', 'x'.repeat(150000) + '\n' + 'y'.repeat(65500) + '\n' + line(1))
  await put('web.social-server-out-1__broken.log.gz', Buffer.from('not gzip'))
  const report = await collect({ processes, app: 'web.social-server', sinceMs: 1800000, now })
  assert.equal(report.records.length, 1)
  assert.match(report.warnings.join(), /Cannot fully read/)
  assert.match(report.warnings.join(), /oversized/)
  const limited = await collect({ processes, app: 'web.social-server', sinceMs: 1800000, now, maxBytes: 10 })
  assert.match(limited.warnings.join(), /byte limit/)
})

it('replaces one fixed archive, preserves old report on contention and removes staging file', async t => {
  const { dir } = await fixture(t)
  const output = path.join(dir, 'relay-diagnostic.json.gz')
  await writeReport(output, { sequence: 1 })
  await writeReport(output, { sequence: 2 })
  assert.deepEqual(JSON.parse(gunzipSync(await readFile(output))), { sequence: 2 })
  assert.deepEqual(await readdir(dir), ['relay-diagnostic.json.gz'])
  assert.equal((await stat(output)).mode & 0o777, 0o600)
  const circular = {}; circular.self = circular
  await assert.rejects(writeReport(output, circular), /circular/i)
  assert.deepEqual(JSON.parse(gunzipSync(await readFile(output))), { sequence: 2 })
  assert.deepEqual(await readdir(dir), ['relay-diagnostic.json.gz'])
  await writeFile(output + '.tmp', 'owned by another collector')
  await assert.rejects(writeReport(output, { sequence: 3 }), { code: 'EEXIST' })
  assert.deepEqual(JSON.parse(gunzipSync(await readFile(output))), { sequence: 2 })
  assert.equal(await readFile(output + '.tmp', 'utf8'), 'owned by another collector')
})

it('uses the fixed default, rejects invalid inputs and does not contact PM2 for help', async () => {
  assert.equal(parseOptions([]).output, DEFAULT_OUTPUT)
  assert.equal(parseOptions(['--since=2h']).sinceMs, 7200000)
  for (const arg of ['--since=0m', '--since=8d', '--since=invalid', '--output=/tmp/x', '--unknown']) assert.throws(() => parseOptions([arg]))
  await run({ argv: ['--help'], getProcesses: () => { throw new Error('must not contact PM2') }, log: () => {} })
  await assert.rejects(collect({ processes: [], app: 'missing', sinceMs: 60000, now }), /PM2 app not found/)
})

it('prioritizes recent lines in a large plain log without unbounded scanning', async t => {
  const { processes, put } = await fixture(t)
  await put('web.social-server-out-0.log', line(8) + 'old noise\n'.repeat(20000) + line(1))
  const report = await collect({ processes, app: 'web.social-server', sinceMs: 1800000, now, maxBytes: 4096 })
  assert.deepEqual(report.records.map(row => row.pid), [1])
  assert.match(report.warnings.join(), /Read only part/)
  assert.ok(report.scannedBytes <= 4096)
})
