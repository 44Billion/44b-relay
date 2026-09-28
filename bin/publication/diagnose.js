import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream } from 'node:fs'
import { readdir, stat, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGunzip, gzip } from 'node:zlib'
import { PUBLICATION_LOG_MARKER } from '../../services/diagnostics/publication.js'

const execute = promisify(execFile)
const compress = promisify(gzip)
export const DEFAULT_OUTPUT = '/tmp/relay-diagnostic.json.gz'
const MAX_FILES = 512
const MAX_RECORDS = 2000
const MAX_LINE_BYTES = 64 * 1024
const MAX_SCAN_BYTES = 256 * 1024 * 1024
const MAX_FILE_BYTES = 32 * 1024 * 1024

export function parseOptions (argv) {
  const options = { app: 'web.social-server', sinceMs: 30 * 60 * 1000, output: DEFAULT_OUTPUT }
  for (const arg of argv) {
    if (arg === '--help') options.help = true
    else if (arg.startsWith('--app=')) options.app = arg.slice(6)
    else if (arg.startsWith('--output=')) options.output = path.resolve(arg.slice(9))
    else if (arg.startsWith('--since=')) {
      const match = /^(\d+)(m|h|d)$/.exec(arg.slice(8))
      if (!match) throw new Error('--since requires an integer and m, h or d (example: 30m)')
      options.sinceMs = Number(match[1]) * { m: 60000, h: 3600000, d: 86400000 }[match[2]]
    } else throw new Error(`Unknown option: ${arg}`)
  }
  if (!options.app || !Number.isSafeInteger(options.sinceMs) || options.sinceMs <= 0 || options.sinceMs > 7 * 86400000) throw new Error('Use a nonempty --app and --since between 1m and 7d')
  if (!options.output.endsWith('.json.gz')) throw new Error('--output must end in .json.gz')
  return options
}

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export async function discoverLogs (processes, app, since) {
  const matching = processes.filter(item => (item.name ?? item.pm2_env?.name) === app)
  if (!matching.length) throw new Error(`PM2 app not found: ${app}. Run as the same user/PM2_HOME as the server.`)
  const configured = [...new Set(matching.flatMap(item => [item.pm2_env?.pm_out_log_path, item.pm2_env?.pm_err_log_path]).filter(file => file && file !== '/dev/null'))]
  if (!configured.length) throw new Error('PM2 reports no log files for this app')
  const files = new Map()
  const warnings = []
  for (const configuredFile of configured) {
    const directory = path.dirname(configuredFile)
    // PM2 uses per-instance suffixes; include retained rotations from previous workers too.
    const stem = path.basename(configuredFile).replace(/\.log$/, '').replace(/-\d+$/, '')
    const pattern = new RegExp(`^${escapeRegex(stem)}(?:-\\d+)?(?:__[^/]+)?\\.log(?:\\.\\d+)?(?:\\.gz)?$`)
    let entries
    try { entries = await readdir(directory) } catch (error) {
      warnings.push(`Cannot list ${directory}: ${error.code}`)
      continue
    }
    for (const entry of entries) {
      const file = path.join(directory, entry)
      if (file !== configuredFile && !pattern.test(entry)) continue
      try {
        const info = await stat(file)
        if (info.isFile() && info.mtimeMs >= since && info.size > 0) files.set(file, { path: file, size: info.size, mtimeMs: info.mtimeMs })
      } catch (error) { warnings.push(`Cannot inspect ${file}: ${error.code}`) }
    }
  }
  const sorted = [...files.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (sorted.length > MAX_FILES) warnings.push(`File limit reached (${MAX_FILES}); collection is partial`)
  return { instances: matching.length, configured, files: sorted.slice(0, MAX_FILES), warnings }
}

// Whitelist fields again during export, even if other versions append extra data.
function select (source, keys) {
  return Object.fromEntries(keys.filter(key => {
    const value = source?.[key]
    return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 160)
  }).map(key => [key, source[key]]))
}

export function parseRecord (line) {
  // Also accept PM2's optional JSON log wrapper, besides its timestamp prefix.
  if (line.startsWith('{')) {
    try {
      const envelope = JSON.parse(line)
      if (typeof envelope.message === 'string') line = envelope.message
    } catch {}
  }
  const position = line.indexOf(PUBLICATION_LOG_MARKER)
  if (position === -1) return null
  const value = JSON.parse(line.slice(position + PUBLICATION_LOG_MARKER.length))
  if (value.version !== 1 || !Number.isFinite(Date.parse(value.completedAt)) || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) throw new Error('Invalid publication record')
  const record = select(value, ['version', 'at', 'completedAt', 'pid', 'instance', 'eventId', 'kind', 'accepted', 'elapsedMs'])
  record.stages = select(value.stages, ['validation', 'metadata', 'ipcReady', 'persistence', 'broadcast', 'sendOk'])
  record.database = (Array.isArray(value.database) ? value.database : []).slice(0, 32).map(row => select(row, ['index', 'method', 'elapsedMs', 'success']))
  record.tasks = (Array.isArray(value.tasks) ? value.tasks : []).slice(0, 32).map(row => select(row, ['uid', 'batchUid', 'index', 'type', 'status', 'enqueuedAt', 'startedAt', 'finishedAt', 'queueMs', 'executionMs', 'waitMs', 'communicationFailures']))
  record.omitted = select(value.omitted, ['database', 'tasks'])
  return record
}

async function scanFile (file, consume, budget) {
  // Snapshot the byte length so an active file cannot extend the collection indefinitely.
  const compressed = file.path.endsWith('.gz')
  const start = compressed ? 0 : Math.max(0, file.size - Math.min(MAX_FILE_BYTES, budget.maxBytes - budget.bytes))
  if (start > 0) budget.partialFiles.push(file.path)
  const source = createReadStream(file.path, { start, end: file.size - 1 })
  const stream = compressed ? source.pipe(createGunzip()) : source
  const forwardError = error => stream.destroy(error)
  if (stream !== source) source.on('error', forwardError)
  stream.setEncoding('utf8')
  let pending = ''
  let skipping = start > 0 // Discard a possibly partial first line when tailing.
  let fileBytes = 0
  try {
    for await (const chunk of stream) {
      const chunkBytes = Buffer.byteLength(chunk)
      budget.bytes += chunkBytes
      fileBytes += chunkBytes
      if (budget.bytes > budget.maxBytes) { budget.truncated = true; break }
      if (fileBytes > MAX_FILE_BYTES) { budget.partialFiles.push(file.path); pending = ''; break }
      for (const [index, part] of chunk.split('\n').entries()) {
        if (index > 0) {
          if (!skipping && pending) consume(pending)
          pending = ''
          skipping = false
        }
        if (!skipping) {
          if (Buffer.byteLength(pending) + Buffer.byteLength(part) > MAX_LINE_BYTES) { pending = ''; skipping = true; budget.oversizedLines++ } else pending += part
        }
      }
    }
    if (!budget.truncated && !skipping && pending) consume(pending)
  } finally {
    stream.destroy()
    source.destroy()
  }
}

export function summarize (records) {
  const stages = {}
  let maxQueueMs = null
  let maxExecutionMs = null
  let taskCount = 0
  for (const row of records) {
    for (const [name, ms] of Object.entries(row.stages)) {
      if (typeof ms !== 'number') continue
      stages[name] ??= { totalMs: 0, maxMs: 0 }
      stages[name].totalMs = Math.round((stages[name].totalMs + ms) * 100) / 100
      stages[name].maxMs = Math.max(stages[name].maxMs, ms)
    }
    for (const task of row.tasks) {
      taskCount++
      if (typeof task.queueMs === 'number') maxQueueMs = Math.max(maxQueueMs ?? 0, task.queueMs)
      if (typeof task.executionMs === 'number') maxExecutionMs = Math.max(maxExecutionMs ?? 0, task.executionMs)
    }
  }
  return {
    count: records.length, accepted: records.filter(row => row.accepted === true).length,
    rejected: records.filter(row => row.accepted === false).length,
    maxElapsedMs: records.reduce((max, row) => Math.max(max, row.elapsedMs), 0),
    stages, taskCount, maxTaskQueueMs: maxQueueMs, maxTaskExecutionMs: maxExecutionMs
  }
}

export async function collect ({ processes, app, sinceMs, now = Date.now(), maxBytes = MAX_SCAN_BYTES }) {
  const since = now - sinceMs
  const discovered = await discoverLogs(processes, app, since)
  const records = []
  const seen = new Set()
  const budget = { bytes: 0, maxBytes, truncated: false, oversizedLines: 0, partialFiles: [] }
  let malformed = 0
  let matched = 0
  const scanned = []
  for (const file of discovered.files) {
    if (budget.bytes >= budget.maxBytes) { budget.truncated = true; break }
    try {
      await scanFile(file, line => {
        let record
        try { record = parseRecord(line) } catch { malformed++; return }
        if (!record) return
        const at = Date.parse(record.completedAt)
        if (at < since || at > now) return
        matched++
        if (records.length >= MAX_RECORDS) return
        const identity = JSON.stringify(record)
        if (seen.has(identity)) return
        seen.add(identity)
        records.push(record)
      }, budget)
      scanned.push(file.path)
    } catch (error) { discovered.warnings.push(`Cannot fully read ${file.path}: ${error.code || error.message}`) }
    if (budget.truncated) break
  }
  for (const file of budget.partialFiles) discovered.warnings.push(`Read only part of large log ${file}; collection is partial`)
  if (budget.truncated) discovered.warnings.push('Scan byte limit reached; collection is partial')
  if (records.length >= MAX_RECORDS && matched > MAX_RECORDS) discovered.warnings.push(`Record limit reached (${MAX_RECORDS}); collection is partial`)
  if (malformed || budget.oversizedLines) discovered.warnings.push(`Skipped ${malformed} malformed diagnostic lines and ${budget.oversizedLines} oversized lines`)
  records.sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
  return {
    version: 1, generatedAt: new Date(now).toISOString(), since: new Date(since).toISOString(), app,
    instances: discovered.instances, files: scanned, scannedBytes: budget.bytes,
    warnings: discovered.warnings, summary: summarize(records), records,
    limitation: 'Only retained slow-publication logs are included. No records does not prove the absence of delays. Stages/database/task timings overlap and must not be added together.'
  }
}

export async function writeReport (output, report) {
  // One fixed staging file: exclusive creation prevents concurrent collectors from clobbering it.
  // Rename replaces the previous report only after the gzip file is complete.
  const temporary = output + '.tmp'
  let handle
  try { handle = await open(temporary, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') error.message = `Staging file exists: ${temporary}. Another collection may be running; remove it only after confirming none is running.`
    throw error
  }
  let published = false
  try {
    await handle.writeFile(await compress(JSON.stringify(report) + '\n'))
    await handle.sync()
    await handle.close()
    await rename(temporary, output)
    published = true
  } finally {
    await handle.close()
    // After rename another collector may already own the same staging path.
    if (!published) await rm(temporary, { force: true })
  }
}

export async function run ({
  argv = process.argv.slice(2), getProcesses = async () => {
    const { stdout } = await execute('pm2', ['jlist'], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 })
    return JSON.parse(stdout)
  }, log = console.log
} = {}) {
  const options = parseOptions(argv)
  if (options.help) {
    log('Usage: npm run publication:diagnose -- [--since=30m] [--app=web.social-server] [--output=/tmp/relay-diagnostic.json.gz]\nReads current and rotated PM2 logs (including gzip). Replaces the same report each time. No database access or service restart. Run as the PM2 owner. Limits: 7 days, 512 files, 256 MiB scanned (32 MiB/file), 2000 records.')
    return
  }
  const processes = await getProcesses()
  if (!Array.isArray(processes)) throw new Error('Invalid pm2 jlist response')
  const report = await collect({ processes, ...options })
  await writeReport(options.output, report)
  log(`Slow publications: ${report.summary.count}; accepted: ${report.summary.accepted}; rejected: ${report.summary.rejected}; max: ${report.summary.maxElapsedMs} ms`)
  for (const [stage, value] of Object.entries(report.summary.stages).sort((a, b) => b[1].totalMs - a[1].totalMs)) log(`  ${stage}: total ${value.totalMs} ms; max ${value.maxMs} ms`)
  log(`Meilisearch tasks: ${report.summary.taskCount}; max queue ${report.summary.maxTaskQueueMs ?? 'unknown'} ms; max execution ${report.summary.maxTaskExecutionMs ?? 'unknown'} ms`)
  for (const warning of report.warnings) log(`Warning: ${warning}`)
  log(report.limitation)
  log(`Report: ${options.output} (replaces previous file)`)
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().catch(error => { console.error(error.message); process.exitCode = 1 })
}
