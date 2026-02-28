import { getRandomId } from '#helpers/misc.js'
import { getJobByKey, patchJobByKey, putJobByKey } from './dao.js'
import { setTimer, wait } from '#helpers/timer.js'

const HEARTBEAT_INTERVAL = 30 // seconds
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

  const { result: hasRecord } = await getJobByKey(job.key)
  if (!hasRecord || hasRecord.startedAt === undefined || hasRecord.endedAt === undefined) {
    await putJobByKey(job.key, {
      startedAt: hasRecord?.startedAt ?? 0,
      endedAt: hasRecord?.endedAt ?? 0
    })
  }
}

// For starting a job:
// first, update both the startedAt to current time in seconds,
// add a random lockKey value,
// wait 2 seconds, fetch the record again to ensure lockKey matches,
// if so, start the job, else, another worker has taken the job.
export async function startJob (job) {
  const now = Math.floor(Date.now() / 1000)
  const lockKey = getRandomId()

  const patchResult = await patchJobByKey(job.key, { startedAt: now, lockKey, heartbeatedAt: now })
  if (!patchResult.success) {
    console.error(`[worker] patchJobByKey FAILED for ${job.key}:`, patchResult.error)
  }

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

    heartbeatLoop()

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
      const MAX_TIMEOUT_MS = 2147483647 // 2^31 - 1

      // If maxDuration exceeds the max Node.js setTimeout delay, the worker will
      // bypass the timeout logic and simply run the job indefinitely,
      // which matches the intent of setting a very high job.maxDuration.
      if (maxDuration > MAX_TIMEOUT_MS) {
        await job.run()
      } else {
        let timeoutId
        const timeoutPromise = new Promise((resolve, reject) => {
          timeoutId = setTimer(() => reject(new Error(`Job timed out after ${maxDuration}ms`)), maxDuration)
        })

        try {
          await Promise.race([job.run(), timeoutPromise])
        } finally {
          clearTimeout(timeoutId)
        }
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

// Trigger a manual job that uses the DB lock mechanism.
// Ensures the DB record exists, then delegates to startJob.
// Returns { started: boolean }.
export async function triggerManualJob (jobConfig) {
  await maybeEnsureRecordForJob(jobConfig)
  return startJob(jobConfig)
}
