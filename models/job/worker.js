import jobs from './jobs/index.js'
import { getJobByKey } from './dao.js'
import { setTimer } from '#helpers/timer.js'
import { maybeEnsureRecordForJob, startJob } from './trigger.js'

const HEARTBEAT_TOLERANCE = 120 // seconds
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
    try {
      const { retriggerAfter } = await maybeTriggerJob(job)
      if (retriggerAfter === null) return
      scheduleJob(job, { retriggerAfter })
    } catch (err) {
      console.error(`Error in job loop for ${job.key}:`, err)
      // Retry after a default delay if an unexpected error occurs (e.g. DB down)
      scheduleJob(job, { retriggerAfter: job.frequency || 60 })
    }
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

  const isRunning = record.endedAt < record.startedAt
  const isExpired = !isRunning && !job.manual && ((now - record.endedAt) >= job.frequency)
  const isRequested = record.requestedAt && record.requestedAt > record.endedAt
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
