import jobs from './jobs/index.js'
import { getJobByKey } from './dao.js'
import { setTimer } from '#helpers/timer.js'
import {
  DEFAULT_HEARTBEAT_TOLERANCE,
  maybeEnsureRecordForJob,
  startJob
} from './trigger.js'
import {
  isLeader as isIpcLeader,
  subscribeLeadership as subscribeIpcLeadership
} from '#services/ipc/cross-process-broadcaster.js'
import { waitForTaskQueueBarrier } from '#services/db/tasks.js'
import { getRandomId } from '#helpers/misc.js'

const DEFAULT_MAX_DURATION = 12 * 60 * 60 // 12 hours
const DEFAULT_ACTIVATION_RETRY_MS = 5000

function abortError (message) {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function makeRuntime ({ signal, leader = false } = {}) {
  return {
    active: true,
    leader,
    ownerId: leader ? `${process.pid}:${getRandomId()}` : null,
    signal,
    timers: new Set(),
    runs: new Set()
  }
}

function stopRuntime (runtime, reason = new Error('Job scheduler stopped')) {
  if (!runtime?.active) return
  runtime.active = false
  for (const timer of runtime.timers) clearTimeout(timer)
  runtime.timers.clear()
  if (runtime.controller && !runtime.controller.signal.aborted) {
    runtime.controller.abort(reason)
  }
}

async function settleRuntime (runtime) {
  if (!runtime) return
  await Promise.allSettled([...runtime.runs])
}

// For each job:
// - unlocked jobs run in every process, because they flush process-local state;
// - locked jobs are scheduled only by the current Unix-socket leader.
export async function init (jobConfigs = jobs, options = {}) {
  const unlockedJobs = jobConfigs.filter(job => !job.shouldUseLock)
  const lockedJobs = jobConfigs.filter(job => job.shouldUseLock)
  const localController = new AbortController()
  const localRuntime = makeRuntime({
    signal: localController.signal,
    leader: false
  })

  for (const job of unlockedJobs) scheduleJob(job, localRuntime)

  let leaderRuntime = null
  let activationController = null
  let activationRetryTimer = null
  let desiredLeadership = false
  let transition = Promise.resolve()

  function clearActivationRetry () {
    clearTimeout(activationRetryTimer)
    activationRetryTimer = null
  }

  function retryLeaderActivation () {
    if (!desiredLeadership || leaderRuntime || activationRetryTimer) return
    activationRetryTimer = setTimer(() => {
      activationRetryTimer = null
      if (desiredLeadership && !leaderRuntime) leadershipChanged(true)
    }, options.activationRetryMs ?? DEFAULT_ACTIVATION_RETRY_MS)
  }

  async function deactivateLeader () {
    const runtime = leaderRuntime
    leaderRuntime = null
    if (!runtime) return
    stopRuntime(runtime, abortError('IPC leadership lost'))
    await settleRuntime(runtime)
  }

  async function activateLeader () {
    if (!desiredLeadership || leaderRuntime) return

    activationController = new AbortController()
    const waitForBarrier =
      options.waitForTaskQueueBarrier || waitForTaskQueueBarrier
    await waitForBarrier({ signal: activationController.signal })
    if (!desiredLeadership || activationController.signal.aborted) return

    for (const job of lockedJobs) {
      await maybeEnsureRecordForJob(job)
    }
    if (!desiredLeadership || activationController.signal.aborted) return

    const runtimeController = new AbortController()
    const runtime = makeRuntime({
      signal: runtimeController.signal,
      leader: true
    })
    runtime.controller = runtimeController
    leaderRuntime = runtime
    for (const job of lockedJobs) scheduleJob(job, runtime)
  }

  function leadershipChanged (isLeader) {
    desiredLeadership = isLeader
    if (!isLeader) {
      clearActivationRetry()
      activationController?.abort(abortError('IPC leadership lost during activation'))
      stopRuntime(leaderRuntime, abortError('IPC leadership lost'))
    }
    transition = transition
      .then(() => isLeader ? activateLeader() : deactivateLeader())
      .catch(err => {
        if (err?.name !== 'AbortError') {
          console.error('[worker] Leadership transition failed:', err)
          retryLeaderActivation()
        }
      })
    return transition
  }

  let unsubscribeLeadership = () => {}
  if (options.leadership) {
    unsubscribeLeadership = options.leadership.subscribe(leadershipChanged)
  } else if (process.env.NODE_ENV === 'test') {
    await leadershipChanged(true)
  } else {
    unsubscribeLeadership = subscribeIpcLeadership(leadershipChanged)
    if (isIpcLeader()) await leadershipChanged(true)
  }

  return async function stop () {
    unsubscribeLeadership()
    desiredLeadership = false
    clearActivationRetry()
    activationController?.abort(abortError('Job worker stopped'))
    localController.abort(abortError('Job worker stopped'))
    stopRuntime(localRuntime, abortError('Job worker stopped'))
    await leadershipChanged(false)
    await settleRuntime(localRuntime)
  }
}

// Add jitter to avoid bursts when several jobs become due together.
function scheduleJob (job, runtime, options = {}) {
  if (!runtime.active || runtime.signal?.aborted) return
  const { retriggerAfter } = options
  const timeout = retriggerAfter
    ? retriggerAfter * 1000
    : Math.random() * 1000 * (job.initialDelay ?? 60)

  const timer = setTimer(async () => {
    runtime.timers.delete(timer)
    if (!runtime.active || runtime.signal?.aborted) return

    let runPromise
    try {
      runPromise = maybeTriggerJob(job, runtime)
      runtime.runs.add(runPromise)
      const { retriggerAfter } = await runPromise
      if (retriggerAfter === null || !runtime.active || runtime.signal?.aborted) return
      scheduleJob(job, runtime, { retriggerAfter })
    } catch (err) {
      if (runtime.signal?.aborted || err?.name === 'AbortError') return
      console.error(`Error in job loop for ${job.key}:`, err)
      if (runtime.active) {
        scheduleJob(job, runtime, { retriggerAfter: job.frequency || 60 })
      }
    } finally {
      if (runPromise) runtime.runs.delete(runPromise)
    }
  }, timeout)
  runtime.timers.add(timer)
}

// Finds whether a job is due, requested, expired, or stalled. Locked jobs only
// reach this function in the IPC leader, while the persisted revision/lockKey
// protects manual triggers and unexpected overlapping callers.
async function maybeTriggerJob (job, runtime) {
  const jitter = Math.random() * 5
  if (!job.shouldUseLock) {
    try {
      await job.run({ signal: runtime.signal })
    } catch (err) {
      if (!runtime.signal?.aborted && err?.name !== 'AbortError') console.error(err)
    }
    return { retriggerAfter: job.manual ? null : job.frequency + jitter }
  }

  const { result: record } = await getJobByKey(job.key)
  if (!record) return { retriggerAfter: job.frequency || 60 }

  const now = Math.floor(Date.now() / 1000)
  const maxDuration = job.maxDuration || DEFAULT_MAX_DURATION
  const isRunning = record.endedAt < record.startedAt
  const isExpired = !isRunning && !job.manual && ((now - record.endedAt) >= job.frequency)
  const isRequested = !isRunning &&
    record.requestedAt &&
    record.requestedAt > record.endedAt
  const isRunningTooLong = isRunning && (now - record.startedAt) >= maxDuration
  const heartbeatTolerance = job.heartbeatTolerance ?? DEFAULT_HEARTBEAT_TOLERANCE
  const isStalled = isRunning &&
    (now - (record.heartbeatedAt || record.startedAt)) >= heartbeatTolerance
  const belongsToPreviousWorker = runtime.leader &&
    !job.manual &&
    isRunning &&
    record.ownerType === 'worker' &&
    record.ownerId &&
    record.ownerId !== runtime.ownerId

  let started = false
  let freshRecord = record
  const shouldRecoverRunningJob = !job.manual &&
    (isRunningTooLong || isStalled || belongsToPreviousWorker)
  if (isExpired || isRequested || shouldRecoverRunningJob) {
    const result = await startJob(job, {
      record,
      ownerId: runtime.ownerId,
      ownerType: 'worker',
      signal: runtime.signal
    })
    started = result.started
    if (result.record) freshRecord = result.record
  }

  if (started) {
    return { retriggerAfter: job.frequency + jitter }
  }

  const { startedAt, endedAt, heartbeatedAt } = freshRecord
  if (endedAt >= startedAt) {
    if (job.manual) return { retriggerAfter: (job.frequency || 60) + jitter }
    const diff = (endedAt + job.frequency) - now
    return { retriggerAfter: Math.max(0, diff) + jitter }
  }
  if (job.manual) {
    return { retriggerAfter: (job.frequency || 60) + jitter }
  }

  const diffMaxDuration = (startedAt + maxDuration) - now
  const diffHeartbeat = ((heartbeatedAt || startedAt) + heartbeatTolerance) - now
  const diff = Math.min(diffMaxDuration, diffHeartbeat)
  return { retriggerAfter: Math.max(0, diff) + jitter }
}
