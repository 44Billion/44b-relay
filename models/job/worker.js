import jobs from './jobs/index.js'
import { getRandomId } from '#helpers/misc.js'
import { getJobByKey, patchJobByKey, putJobByKey } from './dao.js'

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
export async function init () {
  for (const job of jobs) {
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

  setTimeout(async () => {
    const { retriggerAfter } = await maybeTriggerJob(job)
    scheduleJob(job, { retriggerAfter })
  }, timeout)
}

// Find the job by key
// - If it ended too long ago (as of frequency), start it
// - If endedAt is before startedAt (it is probably already running)
// and it is taking too long to end (as of maxDuration), start it
//
// Returns { retriggerAfter: seconds }
// To calculate retriggerAfter (when to call maybeTriggerJob again),
// - If it has ended recently, retrigger after endedAt + frequency + jitter
// - If it has ended too long ago, right now + jitter
// - If it is running, retrigger after startedAt + maxDuration + jitter
// which will end up checking if other worker was unable to set endedAt in time
async function maybeTriggerJob (job) {
  if (!job.shouldUseLock) {
    try {
      await job.run()
    } catch (err) {
      console.error(err)
    }
    return { retriggerAfter: job.frequency }
  }

  const { result: record } = await getJobByKey(job.key)
  const now = Math.floor(Date.now() / 1000)
  const jitter = Math.random() * 5

  const isExpired = (now - record.endedAt) >= job.frequency
  const isRunningTooLong = record.endedAt < record.startedAt &&
    (now - record.startedAt) >= job.maxDuration

  let started = false
  let freshRecord = record
  if (isExpired || isRunningTooLong) {
    const result = await startJob(job)
    started = result.started
    if (result.record) freshRecord = result.record
  }

  if (started) {
    return { retriggerAfter: job.frequency + jitter }
  } else {
    const { startedAt, endedAt } = freshRecord

    if (endedAt >= startedAt) {
      const diff = (endedAt + job.frequency) - now
      return { retriggerAfter: Math.max(0, diff) + jitter }
    } else {
      const diff = (startedAt + job.maxDuration) - now
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

  await patchJobByKey(job.key, { startedAt: now, lockKey })

  await new Promise(resolve => setTimeout(resolve, 2000))

  const { result: record } = await getJobByKey(job.key)
  if (record.lockKey === lockKey) {
    let error
    try {
      await job.run()
    } catch (err) {
      console.error(err)
      error = err
    } finally {
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
