import '#config/dotenv.js'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Meilisearch } from 'meilisearch'
import { PENDING_OPS_SORT } from '#models/pending-op/order.js'

const WARNING_AGE_MS = 60_000
const CRITICAL_AGE_MS = 5 * 60_000
const MIN_TREND_WINDOW_MS = 30_000
const MAX_WATCH_SECONDS = 24 * 60 * 60
const WORKFLOW_FILTER =
  'phase != "queued" AND ' +
  '(type = "upsertManifestWithReservation" OR ' +
  'type = "deleteEventsWithAccounting")'
const ATTRIBUTES = [
  'key',
  'type',
  'phase',
  'createdAt',
  'startedAt',
  'batchId',
  'position',
  'source'
]
const SEVERITY = Object.freeze({
  ok: 0,
  info: 1,
  warning: 2,
  critical: 3
})

export function parseArgs (argv) {
  const options = {
    watchSeconds: 0,
    intervalSeconds: 10,
    intervalWasExplicit: false
  }
  for (const arg of argv) {
    if (arg === '--help') options.help = true
    else if (arg.startsWith('--watch=')) {
      options.watchSeconds = Number(arg.slice('--watch='.length))
    } else if (arg.startsWith('--interval=')) {
      options.intervalSeconds = Number(arg.slice('--interval='.length))
      options.intervalWasExplicit = true
    } else {
      throw new TypeError(`Unknown option: ${arg}`)
    }
  }

  if (!Number.isSafeInteger(options.watchSeconds) ||
      options.watchSeconds < 0 ||
      options.watchSeconds > MAX_WATCH_SECONDS) {
    throw new TypeError(
      `--watch must be an integer from 0 to ${MAX_WATCH_SECONDS} seconds`
    )
  }
  if (!Number.isSafeInteger(options.intervalSeconds) ||
      options.intervalSeconds <= 0) {
    throw new TypeError('--interval must be a positive integer in seconds')
  }
  if (!options.watchSeconds && options.intervalWasExplicit) {
    throw new TypeError('--interval requires --watch')
  }
  return options
}

function timestampMs (value) {
  if (Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function ageMs (value, checkedAtMs) {
  const timestamp = timestampMs(value)
  return timestamp === null ? null : Math.max(0, checkedAtMs - timestamp)
}

function summarizeOperation (operation, checkedAtMs) {
  if (!operation) return null
  return {
    key: operation.key,
    type: operation.type,
    phase: operation.phase || 'queued',
    createdAt: operation.createdAt,
    startedAt: operation.startedAt,
    batchId: operation.batchId,
    position: operation.position,
    source: operation.source,
    queuedForMs: ageMs(operation.createdAt, checkedAtMs),
    startedForMs: operation.startedAt === undefined
      ? null
      : ageMs(operation.startedAt, checkedAtMs)
  }
}

function normalizePhaseCounts (count, facetDistribution) {
  const phases = Object.fromEntries(
    Object.entries(facetDistribution?.phase || {})
      .sort(([left], [right]) => left.localeCompare(right))
  )
  const facetedCount = Object.values(phases).reduce(
    (total, value) => total + value,
    0
  )
  if (facetedCount < count) phases.unknown = count - facetedCount
  return phases
}

export async function collectSnapshot ({
  client,
  clock = Date.now
}) {
  const checkedAtMs = clock()
  const index = client.index('pendingOps')
  const [stats, oldestResult, startedWorkflowResult] = await Promise.all([
    index.getStats(),
    index.search('', {
      limit: 1,
      sort: PENDING_OPS_SORT,
      facets: ['phase'],
      attributesToRetrieve: ATTRIBUTES
    }),
    index.search('', {
      filter: WORKFLOW_FILTER,
      limit: 1,
      sort: [
        'startedAt:asc',
        ...PENDING_OPS_SORT
      ],
      attributesToRetrieve: ATTRIBUTES
    })
  ])
  const count = stats.numberOfDocuments
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid pendingOps document count: ${count}`)
  }
  return {
    checkedAt: new Date(checkedAtMs).toISOString(),
    count,
    isIndexing: Boolean(stats.isIndexing),
    phases: normalizePhaseCounts(count, oldestResult.facetDistribution),
    oldest: summarizeOperation(oldestResult.hits?.[0], checkedAtMs),
    oldestStartedWorkflow: summarizeOperation(
      startedWorkflowResult.hits?.[0],
      checkedAtMs
    )
  }
}

function formatDuration (milliseconds) {
  if (!Number.isFinite(milliseconds)) return 'unknown'
  if (milliseconds >= 60_000) {
    const minutes = Math.floor(milliseconds / 60_000)
    const seconds = Math.round((milliseconds % 60_000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  return `${(milliseconds / 1000).toFixed(milliseconds >= 10_000 ? 1 : 2)}s`
}

function formatRate (value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} ops/min`
}

function calculateTrend (snapshots) {
  if (snapshots.length < 2) return null
  const first = snapshots[0]
  const last = snapshots.at(-1)
  const observedForMs =
    Date.parse(last.checkedAt) - Date.parse(first.checkedAt)
  if (!Number.isFinite(observedForMs) || observedForMs <= 0) return null

  const oldestKeys = snapshots.map(snapshot => snapshot.oldest?.key || null)
  let headChanges = 0
  for (let index = 1; index < oldestKeys.length; index++) {
    if (oldestKeys[index] !== oldestKeys[index - 1]) headChanges++
  }
  const nonNullOldestKeys = oldestKeys.filter(Boolean)
  const sameOldestThroughout = nonNullOldestKeys.length === snapshots.length &&
    new Set(nonNullOldestKeys).size === 1
  const countDelta = last.count - first.count
  const startQueuedCount = first.phases.queued || 0
  const endQueuedCount = last.phases.queued || 0
  const queuedCountDelta = endQueuedCount - startQueuedCount
  const oldestAgeDeltaMs = sameOldestThroughout &&
    Number.isFinite(first.oldest?.queuedForMs) &&
    Number.isFinite(last.oldest?.queuedForMs)
    ? last.oldest.queuedForMs - first.oldest.queuedForMs
    : null

  return {
    observedForMs,
    sampleCount: snapshots.length,
    startCount: first.count,
    endCount: last.count,
    countDelta,
    netChangePerMinute: countDelta / (observedForMs / 60_000),
    startQueuedCount,
    endQueuedCount,
    queuedCountDelta,
    queuedNetChangePerMinute:
      queuedCountDelta / (observedForMs / 60_000),
    headChanges,
    distinctHeadKeys: new Set(nonNullOldestKeys).size,
    sameOldestThroughout,
    oldestAgeDeltaMs
  }
}

export function analyzeSnapshots (snapshots) {
  if (!snapshots.length) throw new TypeError('At least one snapshot is required')
  const last = snapshots.at(-1)
  const findings = []
  const nextSteps = []
  const addFinding = (level, code, message) => {
    findings.push({ level, code, message })
  }

  if (last.count === 0) {
    addFinding('ok', 'depth', 'The pendingOps queue is empty.')
  } else if (!last.oldest) {
    addFinding(
      'warning',
      'depth',
      `${last.count} pending operation(s) exist, but the oldest one was not returned.`
    )
  } else {
    const queuedForMs = last.oldest.queuedForMs
    const level = queuedForMs >= CRITICAL_AGE_MS
      ? 'critical'
      : queuedForMs >= WARNING_AGE_MS
        ? 'warning'
        : 'info'
    addFinding(
      level,
      'depth',
      `${last.count} pending operation(s); oldest is ${last.oldest.key} ` +
      `(${last.oldest.type}, ${last.oldest.phase}) at ` +
      `${formatDuration(queuedForMs)}.`
    )
  }

  const workflow = last.oldestStartedWorkflow
  if (workflow) {
    const startedForMs = workflow.startedForMs
    const level = startedForMs >= CRITICAL_AGE_MS
      ? 'critical'
      : startedForMs >= WARNING_AGE_MS
        ? 'warning'
        : 'info'
    addFinding(
      level,
      'started-workflow',
      `Oldest started workflow is ${workflow.key} (${workflow.type}, ` +
      `${workflow.phase}) at ${formatDuration(startedForMs)}.`
    )
    if (level === 'warning' || level === 'critical') {
      nextSteps.push(
        `Inspect logs for started workflow ${workflow.key}; started workflows ` +
        'are prioritized ahead of queued operations.'
      )
    }
  } else {
    addFinding('ok', 'started-workflow', 'No in-progress pending workflow was found.')
  }

  const trend = calculateTrend(snapshots)
  if (trend) {
    if (trend.observedForMs < MIN_TREND_WINDOW_MS) {
      addFinding(
        'info',
        'trend',
        `The ${formatDuration(trend.observedForMs)} observation window is too ` +
        'short for a reliable queue trend.'
      )
    } else if (last.count === 0) {
      addFinding(
        'ok',
        'trend',
        'The queue drained during the observation window ' +
        `(${formatRate(trend.netChangePerMinute)} net).`
      )
    } else if (trend.sameOldestThroughout &&
        (trend.oldestAgeDeltaMs === null ||
          trend.oldestAgeDeltaMs >= trend.observedForMs * 0.75)) {
      const level = trend.observedForMs >= WARNING_AGE_MS ||
        last.oldest?.queuedForMs >= CRITICAL_AGE_MS
        ? 'critical'
        : 'warning'
      addFinding(
        level,
        'trend',
        `The same operation ${last.oldest.key} remained at the head for ` +
        `${formatDuration(trend.observedForMs)} while the queue changed by ` +
        `${trend.countDelta} (${formatRate(trend.netChangePerMinute)}).`
      )
      nextSteps.push(
        `Inspect operation ${last.oldest.key} and its related terminal logs ` +
        'before resetting or deleting any queue item.'
      )
    } else if (trend.countDelta > 0 || trend.queuedCountDelta > 0) {
      addFinding(
        'warning',
        'trend',
        `The queue changed by ${trend.countDelta} total and ` +
        `${trend.queuedCountDelta} queued operation(s) over ` +
        `${formatDuration(trend.observedForMs)} ` +
        `(${formatRate(trend.netChangePerMinute)} total, ` +
        `${formatRate(trend.queuedNetChangePerMinute)} queued); the head ` +
        `changed ${trend.headChanges} time(s).`
      )
      nextSteps.push(
        'Repeat a longer observation and compare incoming work with the consumer drain rate.'
      )
    } else if (trend.countDelta < 0) {
      addFinding(
        'ok',
        'trend',
        `The queue shrank by ${Math.abs(trend.countDelta)} operation(s) over ` +
        `${formatDuration(trend.observedForMs)} ` +
        `(${formatRate(trend.netChangePerMinute)} net).`
      )
    } else if (trend.headChanges > 0) {
      addFinding(
        'info',
        'trend',
        `Queue depth was stable and the head changed ${trend.headChanges} ` +
        'time(s), showing consumer progress.'
      )
    } else {
      addFinding(
        'warning',
        'trend',
        'Queue depth and head did not change for ' +
        `${formatDuration(trend.observedForMs)}.`
      )
    }
  }

  const status = findings.reduce((worst, finding) =>
    SEVERITY[finding.level] > SEVERITY[worst] ? finding.level : worst
  , 'ok')
  if (!nextSteps.length) {
    nextSteps.push(
      snapshots.length === 1
        ? 'Use --watch=120 --interval=10 to distinguish a transient snapshot from sustained growth.'
        : 'No immediate action is suggested; repeat the monitor if queue age or depth increases.'
    )
  }
  return {
    status,
    headline: status === 'critical'
      ? 'The pendingOps queue may be blocked.'
      : status === 'warning'
        ? 'The pendingOps queue should be reviewed.'
        : 'No immediate pendingOps problem was detected.',
    findings,
    trend,
    nextSteps: [...new Set(nextSteps)],
    limitation: snapshots.length === 1
      ? 'A single snapshot cannot determine whether queue depth is increasing.'
      : 'The reported rate is net queue change; it does not separately measure arrivals and completions.'
  }
}

function progressLine (snapshot) {
  const oldest = snapshot.oldest
    ? `${snapshot.oldest.key}:${formatDuration(snapshot.oldest.queuedForMs)}`
    : 'none'
  return `[pending-ops] ${snapshot.checkedAt} count=${snapshot.count} oldest=${oldest}`
}

function sleep (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export async function run ({
  argv = process.argv.slice(2),
  Client = Meilisearch,
  logger = console,
  clock = Date.now,
  wait = sleep
} = {}) {
  const options = parseArgs(argv)
  if (options.help) {
    logger.log(`Usage: npm run pending-ops:status -- [options]

Without options, prints one read-only pendingOps snapshot and analysis.

Options:
  --watch=SECONDS     Observe queue changes for up to 24 hours
  --interval=SECONDS  Sampling interval used with --watch (default: 10)
  --help              Show this help`)
    return
  }

  const client = new Client({
    host: process.env.MDB_HOST || 'http://127.0.0.1:7700',
    apiKey: process.env.MDB_API_KEY || 'meilisearchmasterkey'
  })
  const snapshots = []
  let elapsedSeconds = 0
  while (true) {
    const snapshot = await collectSnapshot({ client, clock })
    snapshots.push(snapshot)
    if (options.watchSeconds) {
      const logProgress = logger.error || logger.log
      logProgress.call(logger, progressLine(snapshot))
    }
    if (elapsedSeconds >= options.watchSeconds) break

    const waitSeconds = Math.min(
      options.intervalSeconds,
      options.watchSeconds - elapsedSeconds
    )
    await wait(waitSeconds * 1000)
    elapsedSeconds += waitSeconds
  }

  const analysis = analyzeSnapshots(snapshots)
  const result = options.watchSeconds
    ? {
        observedFrom: snapshots[0].checkedAt,
        observedTo: snapshots.at(-1).checkedAt,
        samples: snapshots,
        analysis
      }
    : {
        ...snapshots[0],
        analysis
      }
  logger.log(JSON.stringify(result, null, 2))
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
