import jobs from './jobs/index.js'
import { getRandomId } from '#helpers/misc.js'
import { getJobByKey, patchJobByKey, putJobByKey } from './dao.js'
import { setTimer, wait } from '#helpers/timer.js'

const HEARTBEAT_INTERVAL = 30 // seconds
const HEARTBEAT_TOLERANCE = 90 // seconds
const DEFAULT_MAX_DURATION = 12 * 60 * 60 // 12 hours

// For each job:
// - If job has shouldUseLock=true,
// check if there is a record with this key
// If not or if no startedAt and/or no endedAt,
// create a new record (or update it)
// with startedAt and endedAt (which ever is/are absent)
// set to 0.
// Else, no need to persist anything, just schedule
// js-side according to its frequency and ignore maxDuration
// - Schedule job
export async function init (jobConfigs = jobs) {
  for (const job of jobConfigs) {
    await maybeEnsureRecordForJob(job)
    scheduleJob(job)
  }
}

// Skip if job config has shouldUseLock=false.
//
// Else check if there is a record with the job key
// If not or if no startedAt and/or no endedAt,
// create a new record (or update it)
// with startedAt and endedAt (which ever is/are absent)
// set to 0.
async function maybeEnsureRecordForJob (job) {
  if (!job.shouldUseLock) return

  const { result: hasRecord } = await getJobByKey(job.key)
  if (!hasRecord || hasRecord.startedAt === undefined || hasRecord.endedAt === undefined) {
    await putJobByKey(job.key, {
      startedAt: hasRecord?.startedAt ?? 0,
      endedAt: hasRecord?.endedAt ?? 0
    })
  }
}

// Schedule maybeTriggerJob
// Add some jitter to avoid all workers (from different
// processes) scheduling at the same time.
// Also used to reschedule after maybeTriggerJob
function scheduleJob (job, options = {}) {
  const { retriggerAfter } = options
  const timeout = retriggerAfter
    ? retriggerAfter * 1000
    : Math.random() * 1000 * 60

  setTimer(async () => {
    const { retriggerAfter } = await maybeTriggerJob(job)
    if (retriggerAfter === null) return
    scheduleJob(job, { retriggerAfter })
  }, timeout)
}

// Find the job by key
// - If it ended too long ago (as of frequency), start it
// - If endedAt is before startedAt (it is probably already running)
// and it is taking too long to end (as of maxDuration) or stalled (heartbeat), start it
//
// Returns { retriggerAfter: seconds }
// To calculate retriggerAfter (when to call maybeTriggerJob again),
// - If it has ended recently, retrigger after endedAt + frequency + jitter
// - If it has ended too long ago, right now + jitter
// - If it is running, retrigger after the soonest of maxDuration expiry or heartbeat timeout
async function maybeTriggerJob (job) {
  const jitter = Math.random() * 5
  if (!job.shouldUseLock) {
    try {
      await job.run()
    } catch (err) {
      console.error(err)
    }
    // Manual job with job.shouldUseLock=false won't automatically
    // re-run in case of getting stalled or running too long.
    return { retriggerAfter: job.manual ? null : job.frequency + jitter }
  }

  const { result: record } = await getJobByKey(job.key)
  const now = Math.floor(Date.now() / 1000)

  const maxDuration = job.maxDuration || DEFAULT_MAX_DURATION

  const isExpired = !job.manual && ((now - record.endedAt) >= job.frequency)
  const isRequested = record.requestedAt && record.requestedAt > record.endedAt
  const isRunning = record.endedAt < record.startedAt
  const isRunningTooLong = isRunning && (now - record.startedAt) >= maxDuration
  const isStalled = isRunning &&
    (now - (record.heartbeatedAt || record.startedAt)) >= HEARTBEAT_TOLERANCE

  let started = false
  let freshRecord = record
  if (isExpired || isRequested || isRunningTooLong || isStalled) {
    const result = await startJob(job)
    started = result.started
    if (result.record) freshRecord = result.record
  }

  if (started) {
    return { retriggerAfter: job.frequency + jitter }
  } else {
    const { startedAt, endedAt, heartbeatedAt } = freshRecord

    if (endedAt >= startedAt) {
      // This allows the worker to detect if the manual job was started by another
      // process/mechanism and subsequently stalled or ran too long.
      if (job.manual) return { retriggerAfter: (job.frequency || 60) + jitter }

      const diff = (endedAt + job.frequency) - now
      return { retriggerAfter: Math.max(0, diff) + jitter }
    } else {
      const diffMaxDuration = (startedAt + maxDuration) - now
      const diffHeartbeat = ((heartbeatedAt || startedAt) + HEARTBEAT_TOLERANCE) - now
      const diff = Math.min(diffMaxDuration, diffHeartbeat)
      return { retriggerAfter: Math.max(0, diff) + jitter }
    }
  }
}

// For starting a job:
// first, update both the startedAt to current time in seconds,
// add a random lockKey value,
// wait 2 seconds, fetch the record again to ensure lockKey matches,
// if so, start the job, else, another worker has taken the job.
async function startJob (job) {
  const now = Math.floor(Date.now() / 1000)
  const lockKey = getRandomId()

  await patchJobByKey(job.key, { startedAt: now, lockKey, heartbeatedAt: now })

  await wait(2000)

  const { result: record } = await getJobByKey(job.key)
  if (record.lockKey === lockKey) {
    let heartbeatTimeout
    let stopHeartbeat = false

    const heartbeatLoop = async () => {
      try {
        await patchJobByKey(job.key, { heartbeatedAt: Math.floor(Date.now() / 1000) })
      } catch (err) {
        console.error(err)
      }
      if (stopHeartbeat) return
      heartbeatTimeout = setTimer(heartbeatLoop, HEARTBEAT_INTERVAL * 1000)
    }

    heartbeatTimeout = setTimer(heartbeatLoop, HEARTBEAT_INTERVAL * 1000)

    let error
    try {
      // Use Promise.race to enforce maxDuration.
      // This doesn't kill the thread but allows the worker to release the lock and mark error.
      //
      // In the future, we can consider using Worker Threads (node:worker_threads)
      // if we add CPU-bound jobs and terminate the thread here if maxDuration is reached.
      // Note: No need to proxy mdb client by making worker thread talk to main thread
      // instead of talking directly to MeiliSearch, because MeiliSearch client
      // connection overhead is very low (they're HTTP agents), unless we would want
      // to rate-limit them, e.g., 50 DB writes/second globally across all threads.
      const maxDuration = (job.maxDuration || DEFAULT_MAX_DURATION) * 1000
      let timeoutId
      const timeoutPromise = new Promise((resolve, reject) => {
        timeoutId = setTimer(() => reject(new Error(`Job timed out after ${maxDuration}ms`)), maxDuration)
      })

      try {
        await Promise.race([job.run(), timeoutPromise])
      } finally {
        clearTimeout(timeoutId)
      }
    } catch (err) {
      console.error(err)
      error = err
    } finally {
      stopHeartbeat = true
      clearTimeout(heartbeatTimeout)
      const patch = { endedAt: Math.floor(Date.now() / 1000) }
      if (error) {
        patch.lastError = (error.stack || error.message || String(error)).slice(0, 1000)
        patch.erroedAt = Math.floor(Date.now() / 1000)
      }
      await patchJobByKey(job.key, patch)
    }
    return { started: true }
  }
  return { started: false, record }
}
