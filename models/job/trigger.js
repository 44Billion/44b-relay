import { getRandomId } from '#helpers/misc.js'
import {
  getJobByKey,
  patchJobByKey,
  patchJobByRevision,
  patchJobIfOwned,
  putJobByKey
} from './dao.js'
import { setTimer } from '#helpers/timer.js'

export const HEARTBEAT_INTERVAL = 60 // seconds
export const DEFAULT_HEARTBEAT_TOLERANCE = 240 // seconds
const DEFAULT_MAX_DURATION = 12 * 60 * 60 // 12 hours

// Skip if job config has shouldUseLock=false.
//
// Else check if there is a record with the job key
// If not or if no startedAt and/or no endedAt,
// create a new record (or update it)
// with startedAt and endedAt (which ever is/are absent)
// set to 0.
export async function maybeEnsureRecordForJob (job) {
  if (!job.shouldUseLock) return

  const heartbeatTolerance =
    job.heartbeatTolerance ?? DEFAULT_HEARTBEAT_TOLERANCE
  const { result: record } = await getJobByKey(job.key)
  if (!record) {
    const result = await putJobByKey(job.key, {
      startedAt: 0,
      endedAt: 0,
      heartbeatTolerance
    })
    if (!result.success) throw result.error
    return
  }

  const patch = {}
  if (record.startedAt === undefined) patch.startedAt = 0
  if (record.endedAt === undefined) patch.endedAt = 0
  if (record.revision === undefined) patch.revision = getRandomId()
  if (record.heartbeatTolerance !== heartbeatTolerance) {
    patch.heartbeatTolerance = heartbeatTolerance
  }
  if (Object.keys(patch).length) {
    const result = await patchJobByKey(job.key, patch)
    if (!result.success) throw result.error
  }
}

function abortError (message, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.name = 'AbortError'
  return error
}

function linkAbortSignal (source, controller) {
  if (!source) return () => {}
  const abort = () => {
    if (!controller.signal.aborted) {
      const reason = source.reason
      controller.abort(
        reason?.name === 'AbortError'
          ? reason
          : abortError(reason?.message || 'Job execution aborted', reason)
      )
    }
  }
  if (source.aborted) abort()
  else source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

// Acquires the persisted lease only if the revision read by the caller is
// still current. Every later mutation is fenced by lockKey.
export async function startJob (job, {
  record: expectedRecord,
  ownerId = `manual:${process.pid}:${getRandomId()}`,
  ownerType = 'manual',
  signal
} = {}) {
  if (!expectedRecord) {
    const { result } = await getJobByKey(job.key)
    expectedRecord = result
  }
  if (!expectedRecord?.revision) {
    return { started: false, record: expectedRecord }
  }

  const now = Math.floor(Date.now() / 1000)
  const lockKey = getRandomId()
  const previousEndedAt = Number.isFinite(expectedRecord.endedAt)
    ? expectedRecord.endedAt
    : 0

  const patchResult = await patchJobByRevision(job.key, expectedRecord.revision, {
    startedAt: now,
    // Keep the existing timestamp-based status contract unambiguous even when
    // a job ends and restarts within the same second.
    endedAt: Math.min(previousEndedAt, now - 1),
    lockKey,
    ownerId,
    ownerType,
    heartbeatedAt: now,
    heartbeatTolerance:
      job.heartbeatTolerance ?? DEFAULT_HEARTBEAT_TOLERANCE
  })
  if (!patchResult.success) {
    if (patchResult.error) {
      console.error(`[worker] Could not acquire ${job.key}:`, patchResult.error)
    }
    const { result: record } = await getJobByKey(job.key)
    return { started: false, record }
  }

  const controller = new AbortController()
  const unlinkSignal = linkAbortSignal(signal, controller)
  let heartbeatTimeout
  let heartbeatPromise = Promise.resolve()
  let stopHeartbeat = false

  const heartbeatLoop = async () => {
    if (stopHeartbeat || controller.signal.aborted) return
    const result = await patchJobIfOwned(job.key, lockKey, {
      heartbeatedAt: Math.floor(Date.now() / 1000)
    })
    if (!result.success) {
      if (result.error) {
        console.error(`[worker] Heartbeat failed for ${job.key}:`, result.error)
      }
      if (!controller.signal.aborted) {
        controller.abort(abortError(`Job ${job.key} lost its lock`, result.error))
      }
      return
    }
    if (!stopHeartbeat) {
      heartbeatTimeout = setTimer(startHeartbeat, HEARTBEAT_INTERVAL * 1000)
    }
  }

  const startHeartbeat = () => {
    heartbeatPromise = heartbeatLoop()
  }

  // startedAt/heartbeatedAt were written during acquisition, so an immediate
  // heartbeat would only create an unnecessary Meilisearch task.
  heartbeatTimeout = setTimer(startHeartbeat, HEARTBEAT_INTERVAL * 1000)

  let error
  try {
    controller.signal.throwIfAborted()
    const maxDuration = (job.maxDuration || DEFAULT_MAX_DURATION) * 1000
    const MAX_TIMEOUT_MS = 2147483647 // 2^31 - 1
    const runPromise = Promise.resolve(job.run({ signal: controller.signal }))

    if (maxDuration > MAX_TIMEOUT_MS) {
      await runPromise
    } else {
      let timeoutId
      const timeoutError = new Error(`Job timed out after ${maxDuration}ms`)
      const timeoutPromise = new Promise((resolve, reject) => {
        timeoutId = setTimer(() => {
          if (!controller.signal.aborted) controller.abort(timeoutError)
          reject(timeoutError)
        }, maxDuration)
      })

      try {
        await Promise.race([runPromise, timeoutPromise])
      } finally {
        clearTimeout(timeoutId)
        if (controller.signal.aborted) {
          await runPromise.catch(() => {})
        }
      }
    }
    controller.signal.throwIfAborted()
  } catch (err) {
    error = err
    if (err?.name !== 'AbortError') console.error(err)
  } finally {
    stopHeartbeat = true
    clearTimeout(heartbeatTimeout)
    unlinkSignal()
    await heartbeatPromise

    // An aborted run is intentionally left as owned by the previous runner.
    // The next IPC leader can recognize ownerId and take it immediately. Marking
    // it as ended here would postpone that recovery until the normal frequency.
    if (error?.name !== 'AbortError') {
      const patch = { endedAt: Math.max(now, Math.floor(Date.now() / 1000)) }
      if (error) {
        patch.lastError = (error.stack || error.message || String(error)).slice(0, 1000)
        patch.erroedAt = Math.floor(Date.now() / 1000)
      }
      await patchJobIfOwned(job.key, lockKey, patch)
    }
  }
  return { started: true, error }
}

// Trigger a manual job that uses the DB lock mechanism.
// Ensures the DB record exists, then delegates to startJob.
// Returns { started: boolean }.
export async function triggerManualJob (jobConfig, { signal } = {}) {
  signal?.throwIfAborted()
  await maybeEnsureRecordForJob(jobConfig)
  signal?.throwIfAborted()
  const { result: record } = await getJobByKey(jobConfig.key)
  const now = Math.floor(Date.now() / 1000)
  const tolerance = jobConfig.heartbeatTolerance ?? DEFAULT_HEARTBEAT_TOLERANCE
  const isRunning = record.endedAt < record.startedAt
  const isHealthy = isRunning &&
    (now - (record.heartbeatedAt || record.startedAt)) < tolerance
  if (isHealthy) return { started: false, record }
  return startJob(jobConfig, { record, signal })
}
