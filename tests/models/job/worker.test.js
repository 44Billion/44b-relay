import { describe, it, before, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'

// --- Mock Setup ---
const setTimerMock = mock.fn()
const waitMock = mock.fn()
const maybeUnrefMock = mock.fn((t) => t)

mock.module('#helpers/timer.js', {
  namedExports: {
    setTimer: setTimerMock,
    wait: waitMock,
    maybeUnref: maybeUnrefMock
  }
})

describe('Job Worker (Integration)', () => {
  const jobKey = 'integration-test-job-mocked'
  let job
  let init, getJobByKey // , putJobByKey
  let stopWorker

  before(async () => {
    // Import Worker via dynamic import to ensure mocks apply
    const workerModule = await import('#models/job/worker.js')
    init = workerModule.init

    const daoModule = await import('#models/job/dao.js')
    getJobByKey = daoModule.getJobByKey
    // putJobByKey = daoModule.putJobByKey
  })

  // Virtual Timer System
  let pendingTimers = []
  let activeCallbacks = new Set()
  let schedulerWaiters = new Set()
  let virtualTime = 1000000000000 // Start at fixed large timestamp

  function notifySchedulerChange () {
    const waiters = schedulerWaiters
    schedulerWaiters = new Set()
    for (const resolve of waiters) resolve()
  }

  function waitForSchedulerChange () {
    return new Promise(resolve => schedulerWaiters.add(resolve))
  }

  function trackCallback (result) {
    if (!result?.then) return
    const promise = Promise.resolve(result)
    activeCallbacks.add(promise)
    promise
      .catch(err => console.error('Timer callback error:', err))
      .finally(() => {
        activeCallbacks.delete(promise)
        notifySchedulerChange()
      })
  }

  // Mock Implementations
  setTimerMock.mock.mockImplementation((cb, delay) => {
    const timer = {
      callback: cb,
      triggerAt: virtualTime + delay
    }
    pendingTimers.push(timer)
    notifySchedulerChange()
    return { unref: () => {} }
  })

  waitMock.mock.mockImplementation((ms) => {
    // Return a promise that resolves when virtual time passes
    return new Promise(resolve => {
      const timer = {
        callback: resolve,
        triggerAt: virtualTime + ms
      }
      pendingTimers.push(timer)
      notifySchedulerChange()
    })
  })

  // Advance virtual time and trigger callbacks
  async function tick (ms) {
    virtualTime += ms

    // Process all timers that are now due. A callback may perform real
    // Meilisearch IO before it schedules its next virtual timer, so wait for
    // that observable boundary instead of sleeping for an arbitrary duration.
    while (true) {
      // Sort to maintain order
      pendingTimers.sort((a, b) => a.triggerAt - b.triggerAt)

      const due = []
      const remaining = []

      for (const t of pendingTimers) {
        // Check if due.
        // Note: we use <= virtualTime.
        if (t.triggerAt <= virtualTime) {
          due.push(t)
        } else {
          remaining.push(t)
        }
      }

      pendingTimers = remaining
      if (due.length === 0) break
      const pendingCountBeforeCallbacks = pendingTimers.length

      for (const t of due) {
        try {
          trackCallback(t.callback())
        } catch (err) {
          console.error('Timer callback synchronous error:', err)
        }
      }

      await Promise.resolve()
      while (activeCallbacks.size > 0 &&
             pendingTimers.length === pendingCountBeforeCallbacks) {
        await waitForSchedulerChange()
      }
    }
  }

  beforeEach(async () => {
    stopWorker = null
    pendingTimers = []
    activeCallbacks = new Set()
    schedulerWaiters = new Set()
    virtualTime = 1000000000000

    // Only mock Date. Meilisearch keeps its real timers; the worker uses the
    // injected timer helper above.
    mock.timers.enable({ apis: ['Date'], now: virtualTime })

    await mdb.index('jobs').deleteAllDocuments()

    job = {
      key: jobKey,
      frequency: 60,
      shouldUseLock: true,
      run: mock.fn(async () => {})
    }
  })

  afterEach(async () => {
    await stopWorker?.()
    mock.timers.reset()
  })

  // Update virtual time in the mock timer when we tick the Date
  // Actually `mock.timers.tick` advances the Date mock but NOT our virtualTime variable.
  // We need to keep them in sync if we want Date.now() to increase.
  // So we override `tick` to also advance global mocked date.
  const tickAndSync = async (ms) => {
    mock.timers.tick(ms)
    await tick(ms)
  }

  it('should initialize and create record', async () => {
    stopWorker = await init([job])

    const { result } = await getJobByKey(jobKey)
    assert.ok(result)
    assert.equal(result.startedAt, 0)

    // Should have scheduled the job (1 pending timer)
    assert.equal(pendingTimers.length, 1)
  })

  it('should run job when expired', async () => {
    // Insert expired record
    const expiredTime = (virtualTime / 1000) - 1000
    await mdb.index('jobs').addDocuments([{
      key: jobKey,
      startedAt: expiredTime - 60,
      endedAt: expiredTime,
      lockKey: 'old'
    }])

    stopWorker = await init([job])

    // Trigger scheduled job
    // Jitter is max 60s. Add 1s margin.
    await tickAndSync(60000 + 1000)

    // Advance any short follow-up timer scheduled by the worker.
    await tickAndSync(3000)

    assert.equal(job.run.mock.callCount(), 1)
  })

  it('should take over job if maxDuration exceeded', async () => {
    // Make sure isExpired is false. isExpired = (now - endedAt) >= frequency
    // We want running-too-long to trigger it.
    job.frequency = 10000
    job.maxDuration = 100

    const nowSec = Math.floor(virtualTime / 1000)

    // Condition:
    // isRunning: endedAt < startedAt
    // isRunningTooLong: (now - startedAt) >= maxDuration
    // isExpired: (now - endedAt) >= frequency => (150 < 10000) => False

    await mdb.index('jobs').addDocuments([{
      key: jobKey,
      startedAt: nowSec - 150,
      endedAt: nowSec - 151,
      heartbeatedAt: nowSec,
      lockKey: 'other'
    }])

    stopWorker = await init([job])

    // Trigger scheduled job
    await tickAndSync(60000 + 1000)

    await tickAndSync(3000)

    assert.equal(job.run.mock.callCount(), 1)
  })

  it('should NOT start job if it is currently running', async () => {
    job.frequency = 60
    const nowSec = Math.floor(virtualTime / 1000)

    await mdb.index('jobs').addDocuments([{
      key: jobKey,
      startedAt: nowSec - 10,     // Started 10s ago
      endedAt: nowSec - 1000,     // Ended long ago (previous run)
      heartbeatedAt: nowSec - 10, // Healthy heartbeat
      lockKey: 'running-process'
    }])

    stopWorker = await init([job])

    // Trigger scheduled job check - jitter is max 60s
    await tickAndSync(60000 + 1000)

    // If it decided to start, advancing the virtual clock would expose it.
    await tickAndSync(3000)

    // Should NOT have run because it considers the other process healthy
    assert.equal(job.run.mock.callCount(), 0)
  })

  it('does not steal a healthy lease merely because its owner differs', async () => {
    const nowSec = Math.floor(virtualTime / 1000)
    await mdb.index('jobs').addDocuments([{
      key: jobKey,
      startedAt: nowSec - 10,
      endedAt: nowSec - 20,
      heartbeatedAt: nowSec - 10,
      lockKey: 'healthy-foreign-lock',
      ownerId: '4242:foreign-term',
      ownerPid: 4242,
      ownerType: 'worker'
    }])

    stopWorker = await init([job], {
      isProcessAlive: () => true
    })
    await tickAndSync(61000)

    assert.equal(job.run.mock.callCount(), 0)
    const { result } = await getJobByKey(jobKey)
    assert.equal(result.lockKey, 'healthy-foreign-lock')
  })

  it('recovers a healthy-looking lease when its local owner PID died', async () => {
    const nowSec = Math.floor(virtualTime / 1000)
    await mdb.index('jobs').addDocuments([{
      key: jobKey,
      startedAt: nowSec - 10,
      endedAt: nowSec - 20,
      heartbeatedAt: nowSec - 1,
      lockKey: 'dead-owner-lock',
      ownerId: '4343:dead-term',
      ownerPid: 4343,
      ownerType: 'worker'
    }])

    stopWorker = await init([job], {
      isProcessAlive: pid => pid !== 4343
    })
    await tickAndSync(61000)

    assert.equal(job.run.mock.callCount(), 1)
    const { result } = await getJobByKey(jobKey)
    assert.equal(result.ownerPid, process.pid)
    assert.notEqual(result.lockKey, 'dead-owner-lock')
  })

  it('should handle maxDuration overflow (effectively no limit)', async () => {
    job.maxDuration = Number.MAX_SAFE_INTEGER

    // Ensure record exists and is expired so it starts
    await mdb.index('jobs').addDocuments([{
      key: jobKey,
      startedAt: 0,
      endedAt: 0,
      lockKey: 'none'
    }])

    stopWorker = await init([job])

    // Trigger
    await tickAndSync(60000 + 1000)
    await tickAndSync(3000)

    assert.equal(job.run.mock.callCount(), 1)
  })

  it('should take over job if heartbeat stopped', async () => {
    job.frequency = 10000
    const nowSec = Math.floor(virtualTime / 1000)

    // Condition:
    // isStalled: (now - heartbeatedAt) >= the 240s default tolerance

    await mdb.index('jobs').addDocuments([{
      key: jobKey,
      startedAt: nowSec - 200,
      endedAt: nowSec - 201,
      heartbeatedAt: nowSec - 250,
      lockKey: 'stalled'
    }])

    stopWorker = await init([job])

    await tickAndSync(60000 + 1000)

    await tickAndSync(3000)

    assert.equal(job.run.mock.callCount(), 1)
  })

  it('runs unlocked jobs locally but locked jobs only while IPC leader', async () => {
    let leadershipHandler
    let releaseBarrier
    const barrier = new Promise(resolve => { releaseBarrier = resolve })
    const leadership = {
      subscribe (handler) {
        leadershipHandler = handler
        return () => {}
      }
    }
    const unlocked = {
      key: 'unlocked-local',
      frequency: 60,
      initialDelay: 0,
      shouldUseLock: false,
      run: mock.fn(async () => {})
    }
    const locked = {
      ...job,
      initialDelay: 0,
      run: mock.fn(async () => {})
    }

    stopWorker = await init([locked, unlocked], {
      leadership,
      waitForTaskQueueBarrier: async () => barrier
    })
    await tickAndSync(0)
    assert.equal(unlocked.run.mock.callCount(), 1)
    assert.equal(locked.run.mock.callCount(), 0)

    const becomingLeader = leadershipHandler(true)
    await tickAndSync(0)
    assert.equal(locked.run.mock.callCount(), 0)

    releaseBarrier()
    await becomingLeader
    await tickAndSync(0)
    assert.equal(locked.run.mock.callCount(), 1)

    await leadershipHandler(false)
    // The scheduler adds up to five seconds of jitter after each run.
    await tickAndSync(66000)
    assert.equal(unlocked.run.mock.callCount(), 2)
    assert.equal(locked.run.mock.callCount(), 1)
  })

  it('does not take a running manual job during leader activation', async () => {
    const nowSec = Math.floor(virtualTime / 1000)
    const manualJob = {
      ...job,
      manual: true,
      initialDelay: 0,
      run: mock.fn(async () => {})
    }
    await mdb.index('jobs').addDocuments([{
      key: jobKey,
      startedAt: nowSec - 1000,
      endedAt: nowSec - 1001,
      heartbeatedAt: nowSec - 1000,
      requestedAt: nowSec - 900,
      lockKey: 'manual-lock',
      ownerId: 'manual-runner',
      ownerType: 'manual'
    }])

    stopWorker = await init([manualJob])
    await tickAndSync(0)
    assert.equal(manualJob.run.mock.callCount(), 0)
  })

  it('uses a new owner for each leadership term and resumes an aborted job', async () => {
    let leadershipHandler
    const leadership = {
      subscribe (handler) {
        leadershipHandler = handler
        return () => {}
      }
    }
    const ownerIds = []
    const longJob = {
      ...job,
      initialDelay: 0,
      run: mock.fn(({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true
        })
      }))
    }

    stopWorker = await init([longJob], {
      leadership,
      waitForTaskQueueBarrier: async () => {}
    })

    await leadershipHandler(true)
    await tickAndSync(0)
    assert.equal(longJob.run.mock.callCount(), 1)
    ownerIds.push((await getJobByKey(jobKey)).result.ownerId)

    await leadershipHandler(false)
    await leadershipHandler(true)
    await tickAndSync(0)
    assert.equal(longJob.run.mock.callCount(), 2)
    ownerIds.push((await getJobByKey(jobKey)).result.ownerId)

    assert.notEqual(ownerIds[0], ownerIds[1])
  })

  it('retries leader activation after a transient barrier failure', async () => {
    let leadershipHandler
    let barrierCalls = 0
    const leadership = {
      subscribe (handler) {
        leadershipHandler = handler
        return () => {}
      }
    }
    const retryJob = {
      ...job,
      initialDelay: 0,
      run: mock.fn(async () => {})
    }
    const errorMock = mock.method(console, 'error', () => {})

    try {
      stopWorker = await init([retryJob], {
        leadership,
        activationRetryMs: 10,
        waitForTaskQueueBarrier: async () => {
          barrierCalls++
          if (barrierCalls === 1) throw new Error('temporary barrier failure')
        }
      })

      await leadershipHandler(true)
      assert.equal(barrierCalls, 1)

      await tickAndSync(10)
      assert.equal(barrierCalls, 2)

      await tickAndSync(0)
      assert.equal(retryJob.run.mock.callCount(), 1)
    } finally {
      errorMock.mock.restore()
    }
  })
})
