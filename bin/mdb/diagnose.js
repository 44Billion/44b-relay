import '#config/dotenv.js'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Meilisearch } from 'meilisearch'

const TARGET_VERSION = '1.49.0'
const TASK_SOFT_TIMEOUT_MS = 60_000
const QUEUE_WARNING_MS = 30_000
const SLOW_BATCH_WARNING_MS = 10_000
const TASK_HISTORY_WARNING = 750_000
const SEVERITY = Object.freeze({
  ok: 0,
  info: 1,
  warning: 2,
  critical: 3
})

export function parseArgs (argv) {
  const options = {
    slowBatchLimit: 10,
    scanBatches: 200,
    minDurationMs: 1000,
    summaryOnly: false
  }
  for (const arg of argv) {
    if (arg === '--help') options.help = true
    else if (arg === '--summary-only') options.summaryOnly = true
    else if (arg.startsWith('--task=')) options.taskUid = Number(arg.slice(7))
    else if (arg.startsWith('--batch=')) options.batchUid = Number(arg.slice(8))
    else if (arg.startsWith('--slow-batches=')) options.slowBatchLimit = Number(arg.slice(15))
    else if (arg.startsWith('--scan-batches=')) options.scanBatches = Number(arg.slice(15))
    else if (arg.startsWith('--min-duration-ms=')) options.minDurationMs = Number(arg.slice(18))
    else throw new TypeError(`Unknown option: ${arg}`)
  }
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError(`Invalid numeric value for ${key}`)
    }
  }
  return options
}

export function durationMs (duration) {
  if (!duration) return null
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(duration)
  if (!match) return null
  return (
    Number(match[1] || 0) * 60 * 60 +
    Number(match[2] || 0) * 60 +
    Number(match[3] || 0)
  ) * 1000
}

function traceDurationMs (duration) {
  if (typeof duration !== 'string') return null
  const match = /^(\d+(?:\.\d+)?)\s*(ns|µs|us|ms|s|m|h)$/.exec(duration)
  if (!match) return null
  const multipliers = {
    ns: 1 / 1_000_000,
    µs: 1 / 1000,
    us: 1 / 1000,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000
  }
  return Number(match[1]) * multipliers[match[2]]
}

function summarizeBatch (batch) {
  return {
    ...batch,
    durationMs: durationMs(batch.duration)
  }
}

function elapsedMs (timestamp, checkedAt) {
  const startedAt = Date.parse(timestamp)
  const now = Date.parse(checkedAt)
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return null
  return Math.max(0, now - startedAt)
}

function formatDuration (milliseconds) {
  if (!Number.isFinite(milliseconds)) return 'an unknown duration'
  if (milliseconds >= 60_000) {
    const minutes = Math.floor(milliseconds / 60_000)
    const seconds = Math.round((milliseconds % 60_000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  if (milliseconds >= 1000) {
    return `${(milliseconds / 1000).toFixed(milliseconds >= 10_000 ? 1 : 2)}s`
  }
  return `${Math.round(milliseconds)}ms`
}

function formatNumber (value) {
  return new Intl.NumberFormat('en-US').format(value)
}

function compareVersions (left, right) {
  const parse = value => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value || '')
    return match ? match.slice(1).map(Number) : null
  }
  const leftParts = parse(left)
  const rightParts = parse(right)
  if (!leftParts || !rightParts) return null
  for (let index = 0; index < leftParts.length; index++) {
    if (leftParts[index] !== rightParts[index]) {
      return Math.sign(leftParts[index] - rightParts[index])
    }
  }
  return 0
}

function batchIndexNames (batch) {
  return Object.keys(batch.stats?.indexUids || {})
}

function batchTaskTypes (batch) {
  return Object.keys(batch.stats?.types || {})
}

function dominantLeafPhase (batch) {
  const trace = batch.stats?.progressTrace
  if (!trace || typeof trace !== 'object') return null
  const entries = Object.entries(trace)
  const leaves = entries.filter(([path]) =>
    !entries.some(([candidate]) =>
      candidate !== path && candidate.startsWith(`${path} > `)
    )
  )
  let dominant = null
  for (const [phasePath, duration] of leaves) {
    const milliseconds = traceDurationMs(duration)
    if (milliseconds === null ||
        (dominant && dominant.durationMs >= milliseconds)) continue
    dominant = {
      path: phasePath,
      phase: phasePath.split(' > ').at(-1),
      duration,
      durationMs: milliseconds
    }
  }
  if (!dominant) return null
  dominant.share = batch.durationMs
    ? dominant.durationMs / batch.durationMs
    : null
  return dominant
}

function countBatchStatuses (batches, status) {
  return batches.reduce(
    (total, batch) => total + (batch.stats?.status?.[status] || 0),
    0
  )
}

function maximumBlockingRatio (batches) {
  return batches.reduce((maximum, batch) => Math.max(
    maximum,
    batch.stats?.writeChannelCongestion?.blocking_ratio || 0
  ), 0)
}

export function analyzeDiagnostics (diagnostics, {
  targetVersion = TARGET_VERSION,
  minDurationMs = 1000
} = {}) {
  const findings = []
  const nextSteps = []
  const addFinding = (level, code, message) => {
    findings.push({ level, code, message })
  }

  if (diagnostics.health?.status === 'available') {
    addFinding('ok', 'health', 'Meilisearch reports itself as available.')
  } else {
    addFinding(
      'critical',
      'health',
      `Meilisearch health is ${diagnostics.health?.status || 'unknown'}.`
    )
    nextSteps.push('Check the Meilisearch service logs before making any database changes.')
  }

  const queueTotal = diagnostics.queue?.total || 0
  const oldestTask = diagnostics.queue?.oldest
  const oldestTaskAge = oldestTask
    ? elapsedMs(oldestTask.enqueuedAt || oldestTask.startedAt, diagnostics.checkedAt)
    : null
  if (queueTotal === 0) {
    addFinding(
      'ok',
      'queue',
      'The active task queue is empty at the time of this check.'
    )
  } else if (!oldestTask) {
    addFinding(
      'warning',
      'queue',
      `The API reports ${formatNumber(queueTotal)} active tasks but did not return the oldest one.`
    )
  } else if (oldestTaskAge !== null &&
      oldestTaskAge >= TASK_SOFT_TIMEOUT_MS) {
    addFinding(
      'critical',
      'queue',
      `The oldest active task #${oldestTask.uid} has been queued for ` +
      `${formatDuration(oldestTaskAge)}, beyond the 60s soft timeout.`
    )
    nextSteps.push(
      `Inspect the oldest task with NODE_ENV=production npm run mdb:diagnose -- --task=${oldestTask.uid}.`
    )
  } else if ((oldestTaskAge !== null &&
      oldestTaskAge >= QUEUE_WARNING_MS) || queueTotal >= 100) {
    addFinding(
      'warning',
      'queue',
      `${formatNumber(queueTotal)} tasks are active; the oldest is #${oldestTask.uid}` +
      (oldestTaskAge === null
        ? '.'
        : ` at ${formatDuration(oldestTaskAge)} in the queue.`)
    )
  } else {
    addFinding(
      'info',
      'queue',
      `${formatNumber(queueTotal)} tasks are active and the oldest has not reached the warning threshold.`
    )
  }

  const retainedTasks = diagnostics.taskHistory?.total
  if (Number.isSafeInteger(retainedTasks)) {
    if (retainedTasks > TASK_HISTORY_WARNING) {
      addFinding(
        'warning',
        'task-history',
        `${formatNumber(retainedTasks)} task records are retained, above the ` +
        `${formatNumber(TASK_HISTORY_WARNING)} cleanup alert threshold.`
      )
      nextSteps.push(
        'Confirm that cleanupMeiliTasks is running hourly and that the retained task count is decreasing.'
      )
    } else {
      addFinding(
        'ok',
        'task-history',
        `${formatNumber(retainedTasks)} task records are retained, below the cleanup alert threshold.`
      )
    }
  }

  const currentVersion = diagnostics.version?.pkgVersion
  const versionComparison = compareVersions(currentVersion, targetVersion)
  if (versionComparison === null) {
    addFinding(
      'warning',
      'version',
      `Could not compare Meilisearch version ${currentVersion || 'unknown'} with project target ${targetVersion}.`
    )
  } else if (versionComparison < 0) {
    addFinding(
      'warning',
      'version',
      `Meilisearch ${currentVersion} is older than this project's target ${targetVersion}.`
    )
    nextSteps.push(
      'Run NODE_ENV=production npm run mdb:upgrade for the read-only upgrade dry-run.'
    )
  } else if (versionComparison > 0) {
    addFinding(
      'info',
      'version',
      `Meilisearch ${currentVersion} is newer than this project's tested target ${targetVersion}; verify client compatibility.`
    )
  } else {
    addFinding(
      'ok',
      'version',
      `Meilisearch is running the project target version ${targetVersion}.`
    )
  }

  const scannedBatches = diagnostics.scannedBatches || []
  const failedTasks = countBatchStatuses(scannedBatches, 'failed')
  const canceledTasks = countBatchStatuses(scannedBatches, 'canceled')
  if (failedTasks || canceledTasks) {
    addFinding(
      'warning',
      'recent-failures',
      `The scanned batches contain ${formatNumber(failedTasks)} failed and ` +
      `${formatNumber(canceledTasks)} canceled tasks.`
    )
    nextSteps.push('Inspect failed recent tasks before assuming their requested mutations were applied.')
  }

  const batchesByDuration = scannedBatches
    .filter(batch => batch.durationMs !== null)
    .sort((left, right) => right.durationMs - left.durationMs)
  const longestBatch = batchesByDuration[0]
  const warningBatches = batchesByDuration.filter(
    batch => batch.durationMs >= SLOW_BATCH_WARNING_MS
  )
  const timeoutBatches = batchesByDuration.filter(
    batch => batch.durationMs >= TASK_SOFT_TIMEOUT_MS
  )
  if (!longestBatch || longestBatch.durationMs < minDurationMs) {
    addFinding(
      'ok',
      'batch-duration',
      `None of the ${formatNumber(diagnostics.recentBatchesScanned || 0)} ` +
      `scanned batches exceeded ${formatDuration(minDurationMs)}.`
    )
  } else {
    const indexNames = batchIndexNames(longestBatch)
    const typeNames = batchTaskTypes(longestBatch)
    const batchDescription = [
      indexNames.length ? `index ${indexNames.join(', ')}` : null,
      typeNames.length ? typeNames.join(', ') : null
    ].filter(Boolean).join('; ')
    const level = timeoutBatches.length
      ? 'critical'
      : warningBatches.length
        ? 'warning'
        : 'info'
    addFinding(
      level,
      'batch-duration',
      `${formatNumber(diagnostics.slowBatchCount || 0)} of ` +
      `${formatNumber(diagnostics.recentBatchesScanned || 0)} scanned batches ` +
      `exceeded ${formatDuration(minDurationMs)}. The longest was #${longestBatch.uid} ` +
      `at ${formatDuration(longestBatch.durationMs)}` +
      (batchDescription ? ` (${batchDescription}).` : '.')
    )

    const dominantPhase = dominantLeafPhase(longestBatch)
    if (dominantPhase && dominantPhase.share >= 0.5) {
      addFinding(
        level === 'critical' ? 'warning' : 'info',
        'dominant-phase',
        `Batch #${longestBatch.uid} spent ${formatDuration(dominantPhase.durationMs)} ` +
        `(${(dominantPhase.share * 100).toFixed(1)}%) in ` +
        `"${dominantPhase.phase}". The delay is inside Meilisearch indexing, ` +
        'not application network latency.'
      )
    }

    const maximumCongestion = maximumBlockingRatio(
      diagnostics.slowBatches || []
    )
    if (maximumCongestion >= 0.05) {
      addFinding(
        'warning',
        'write-congestion',
        'Slow batches reached a write-channel blocking ratio of ' +
        `${(maximumCongestion * 100).toFixed(1)}%.`
      )
    } else {
      addFinding(
        'ok',
        'write-congestion',
        'The reported slow batches do not show material write-channel congestion.'
      )
    }

    if (warningBatches.length) {
      nextSteps.push(
        versionComparison < 0
          ? 'After upgrading, rerun this diagnostic and compare the longest batch and dominant phase.'
          : `Inspect batch #${longestBatch.uid} and its dominant progress-trace phase before changing application batching.`
      )
    }
  }

  if (diagnostics.task) {
    const task = diagnostics.task
    const taskAge = elapsedMs(
      task.enqueuedAt || task.startedAt,
      diagnostics.checkedAt
    )
    if (task.status === 'failed' || task.status === 'canceled') {
      addFinding(
        'critical',
        'selected-task',
        `Selected task #${task.uid} is ${task.status}: ` +
        `${task.error?.message || task.error?.code || 'no error detail was returned'}.`
      )
    } else if (['enqueued', 'processing'].includes(task.status) &&
        taskAge !== null && taskAge >= TASK_SOFT_TIMEOUT_MS) {
      addFinding(
        'critical',
        'selected-task',
        `Selected task #${task.uid} is still ${task.status} after ${formatDuration(taskAge)}.`
      )
    } else {
      addFinding(
        'info',
        'selected-task',
        `Selected task #${task.uid} is ${task.status}.`
      )
    }
  }

  if (diagnostics.batch) {
    const batch = diagnostics.batch
    addFinding(
      batch.durationMs >= TASK_SOFT_TIMEOUT_MS
        ? 'critical'
        : batch.durationMs >= SLOW_BATCH_WARNING_MS
          ? 'warning'
          : 'info',
      'selected-batch',
      `Selected batch #${batch.uid} took ${formatDuration(batch.durationMs)} ` +
      `and contains ${formatNumber(batch.stats?.totalNbTasks || 0)} tasks.`
    )
  }

  const status = findings.reduce((worst, finding) =>
    SEVERITY[finding.level] > SEVERITY[worst] ? finding.level : worst
  , 'ok')
  if (!nextSteps.length) {
    nextSteps.push(
      'No immediate action is suggested; repeat this check if task latency or queue depth increases.'
    )
  }

  const attentionCount = findings.filter(
    finding => SEVERITY[finding.level] >= SEVERITY.warning
  ).length
  const headline = status === 'ok' || status === 'info'
    ? 'No immediate Meilisearch problem was detected.'
    : status === 'critical'
      ? `${attentionCount} finding(s) require immediate attention.`
      : `${attentionCount} finding(s) should be reviewed.`

  return {
    status,
    headline,
    findings,
    nextSteps: [...new Set(nextSteps)],
    limitation:
      'This is a point-in-time snapshot; an empty queue does not rule out intermittent stalls.'
  }
}

export async function run ({
  argv = process.argv.slice(2),
  Client = Meilisearch,
  logger = console
} = {}) {
  const options = parseArgs(argv)
  if (options.help) {
    logger.log(`Usage: npm run mdb:diagnose -- [options]

Read-only Meilisearch diagnostics. Full output ends with an interpretation;
use --summary-only for the concise analysis alone.

Options:
  --task=UID              Include one task
  --batch=UID             Include one batch
  --slow-batches=N        Show N slow recent batches (default: 10)
  --scan-batches=N        Number of recent batches to inspect (default: 200)
  --min-duration-ms=N     Minimum slow-batch duration (default: 1000)
  --summary-only          Print only the interpreted summary
  --help                  Show this help`)
    return
  }

  const client = new Client({
    host: process.env.MDB_HOST || 'http://127.0.0.1:7700',
    apiKey: process.env.MDB_API_KEY || 'meilisearchmasterkey'
  })
  const [version, health, activeTasks, taskHistory, batches] = await Promise.all([
    client.getVersion(),
    client.health(),
    client.tasks.getTasks({
      statuses: ['enqueued', 'processing'],
      reverse: true,
      limit: 20
    }),
    client.tasks.getTasks({ limit: 1 }),
    options.slowBatchLimit
      ? client.batches.getBatches({ limit: options.scanBatches })
      : Promise.resolve({ results: [], total: 0 })
  ])

  const batchesByDuration = batches.results
    .map(summarizeBatch)
    .filter(batch => batch.durationMs !== null &&
      batch.durationMs >= options.minDurationMs)
    .sort((a, b) => b.durationMs - a.durationMs)
  const slowBatches = batchesByDuration.slice(0, options.slowBatchLimit)

  const result = {
    checkedAt: new Date().toISOString(),
    version,
    health,
    queue: {
      total: activeTasks.total,
      oldest: activeTasks.results[0] || null,
      tasks: activeTasks.results
    },
    taskHistory: {
      total: taskHistory.total,
      cleanupWarningThreshold: TASK_HISTORY_WARNING
    },
    recentBatchesScanned: batches.results.length,
    slowBatchCount: batchesByDuration.length,
    slowBatches
  }
  if (options.taskUid !== undefined) {
    result.task = await client.tasks.getTask(options.taskUid)
  }
  if (options.batchUid !== undefined) {
    result.batch = summarizeBatch(await client.batches.getBatch(options.batchUid))
  }
  result.analysis = analyzeDiagnostics({
    ...result,
    scannedBatches: batches.results.map(summarizeBatch)
  }, {
    minDurationMs: options.minDurationMs
  })

  logger.log(JSON.stringify(
    options.summaryOnly ? result.analysis : result,
    null,
    2
  ))
  return result
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  run().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
