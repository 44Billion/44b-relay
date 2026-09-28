import { AsyncLocalStorage } from 'node:async_hooks'

export const PUBLICATION_LOG_MARKER = '[relay-publication] '
const context = new AsyncLocalStorage()
const MAX_DETAILS = 32
const round = value => Math.round(value * 100) / 100
const duration = (from, to) => {
  const start = Date.parse(from)
  const end = Date.parse(to)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null
}

function append (trace, field, detail) {
  if (!trace?.active) return
  if (trace[field].length < MAX_DETAILS) trace[field].push(detail)
  else trace.omitted[field]++
}

export function publicationResult (accepted) {
  const trace = context.getStore()
  if (trace?.active) trace.accepted = accepted === true
}

export function publicationStage (name, operation) {
  const trace = context.getStore()
  if (!trace?.active) return operation()
  const started = performance.now()
  const finish = () => {
    if (trace.active) trace.stages[name] = round((trace.stages[name] || 0) + performance.now() - started)
  }
  try {
    const result = operation()
    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(finish)
    finish()
    return result
  } catch (error) {
    finish()
    throw error
  }
}

// Await exactly the original promise. No extra database requests or retries.
export function publicationDatabaseCall (promise, { index, method, started }) {
  const trace = context.getStore()
  if (!trace?.active) return promise
  return promise.then(value => {
    append(trace, 'database', { index, method, elapsedMs: round(performance.now() - started), success: true })
    return value
  }, error => {
    append(trace, 'database', { index, method, elapsedMs: round(performance.now() - started), success: false })
    throw error
  })
}

export function publicationTask (task, { waitMs, communicationFailures }) {
  const trace = context.getStore()
  if (!trace?.active) return
  append(trace, 'tasks', {
    uid: task.uid ?? task.taskUid,
    batchUid: task.batchUid ?? null,
    index: task.indexUid ?? null,
    type: task.type,
    status: task.status,
    enqueuedAt: task.enqueuedAt ?? null,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
    queueMs: duration(task.enqueuedAt, task.startedAt),
    executionMs: duration(task.startedAt, task.finishedAt),
    waitMs: round(waitMs),
    communicationFailures
  })
}

export async function tracePublication (event, operation, {
  thresholdMs = Number(process.env.RELAY_PUBLICATION_SLOW_MS ?? 3000),
  log = line => console.log(line)
} = {}) {
  if (!Number.isFinite(thresholdMs) || thresholdMs < 0) thresholdMs = 3000
  const trace = {
    active: true, started: performance.now(), at: new Date().toISOString(),
    accepted: null, stages: {}, database: [], tasks: [], omitted: { database: 0, tasks: 0 }
  }
  return context.run(trace, async () => {
    try {
      return await operation()
    } finally {
      trace.active = false
      const elapsedMs = round(performance.now() - trace.started)
      if (elapsedMs >= thresholdMs) {
        // Explicit allowlist: never log content, tags, author, IP, query arguments or errors.
        const record = {
          version: 1, at: trace.at, completedAt: new Date().toISOString(),
          pid: process.pid, instance: process.env.NODE_APP_INSTANCE ?? null,
          eventId: /^[a-f0-9]{64}$/.test(event?.id) ? event.id : null,
          kind: Number.isSafeInteger(event?.kind) ? event.kind : null,
          accepted: trace.accepted, elapsedMs, stages: trace.stages,
          database: trace.database, tasks: trace.tasks, omitted: trace.omitted
        }
        try { log(PUBLICATION_LOG_MARKER + JSON.stringify(record)) } catch { /* Diagnostics must not affect publication. */ }
      }
    }
  })
}
