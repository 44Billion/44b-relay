import { beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import {
  getJobByKey,
  patchJobByRevision,
  patchJobIfOwned,
  putJobByKey
} from '#models/job/dao.js'
import { startJob } from '#models/job/trigger.js'

describe('persisted job leases', () => {
  beforeEach(async () => {
    await mdb.index('jobs').deleteAllDocuments()
  })

  it('allows only one simultaneous revision-based acquisition', async () => {
    await putJobByKey('lease-race', { startedAt: 0, endedAt: 0 })
    const { result: record } = await getJobByKey('lease-race')
    const run = mock.fn(async () => {})
    const job = {
      key: 'lease-race',
      shouldUseLock: true,
      maxDuration: 60,
      run
    }

    const results = await Promise.all([
      startJob(job, { record, ownerId: 'runner-a', ownerType: 'worker' }),
      startJob(job, { record, ownerId: 'runner-b', ownerType: 'worker' })
    ])

    assert.equal(results.filter(result => result.started).length, 1)
    assert.equal(run.mock.callCount(), 1)
  })

  it('rejects heartbeat and finalization writes from an old lock token', async () => {
    await putJobByKey('lease-fence', { startedAt: 1, endedAt: 1 })
    const { result: initial } = await getJobByKey('lease-fence')
    const acquired = await patchJobByRevision('lease-fence', initial.revision, {
      startedAt: 10,
      endedAt: 1,
      lockKey: 'old-token',
      ownerId: 'old',
      ownerType: 'worker'
    })
    assert.equal(acquired.success, true)

    const { result: oldLease } = await getJobByKey('lease-fence')
    const succeeded = await patchJobByRevision('lease-fence', oldLease.revision, {
      startedAt: 20,
      endedAt: 1,
      lockKey: 'new-token',
      ownerId: 'new',
      ownerType: 'worker'
    })
    assert.equal(succeeded.success, true)

    assert.equal((await patchJobIfOwned('lease-fence', 'old-token', {
      heartbeatedAt: 30
    })).success, false)
    assert.equal((await patchJobIfOwned('lease-fence', 'old-token', {
      endedAt: 30
    })).success, false)

    const { result: final } = await getJobByKey('lease-fence')
    assert.equal(final.lockKey, 'new-token')
    assert.equal(final.ownerId, 'new')
    assert.equal(final.endedAt, 1)
  })

  it('ends an aborted worker lease and requests immediate continuation', async () => {
    await putJobByKey('lease-handoff', { startedAt: 0, endedAt: 0 })
    const { result: initial } = await getJobByKey('lease-handoff')
    const controller = new AbortController()
    let signalRunStarted
    const runStarted = new Promise(resolve => { signalRunStarted = resolve })
    const oldJob = {
      key: 'lease-handoff',
      shouldUseLock: true,
      maxDuration: 60,
      run: mock.fn(async ({ signal }) => {
        signalRunStarted()
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true
          })
        })
      })
    }

    const oldRun = startJob(oldJob, {
      record: initial,
      ownerId: 'runner-old',
      ownerType: 'worker',
      signal: controller.signal
    })
    await runStarted
    const handoff = new Error('leadership lost')
    handoff.name = 'AbortError'
    controller.abort(handoff)
    const oldResult = await oldRun
    assert.equal(oldResult.error, handoff)

    const { result: abandonedLease } = await getJobByKey('lease-handoff')
    assert.ok(abandonedLease.endedAt >= abandonedLease.startedAt)
    assert.equal(abandonedLease.ownerId, 'runner-old')
    assert.equal(abandonedLease.ownerPid, process.pid)
    assert.equal(abandonedLease.continuationRequested, true)

    const nextRun = mock.fn(async () => {})
    const nextResult = await startJob({
      ...oldJob,
      run: nextRun
    }, {
      record: abandonedLease,
      ownerId: 'runner-new',
      ownerType: 'worker'
    })
    assert.equal(nextResult.started, true)
    assert.equal(nextRun.mock.callCount(), 1)

    const { result: completedLease } = await getJobByKey('lease-handoff')
    assert.equal(completedLease.ownerId, 'runner-new')
    assert.ok(completedLease.endedAt >= completedLease.startedAt)
    assert.equal(completedLease.continuationRequested, false)
  })

  it('marks a same-second restart as running until it finishes', async () => {
    const now = Math.floor(Date.now() / 1000)
    await putJobByKey('same-second', { startedAt: now, endedAt: now })
    const { result: record } = await getJobByKey('same-second')
    const controller = new AbortController()
    let notifyStarted
    const started = new Promise(resolve => { notifyStarted = resolve })

    const running = startJob({
      key: 'same-second',
      shouldUseLock: true,
      maxDuration: 60,
      run: async ({ signal }) => {
        notifyStarted()
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true
          })
        })
      }
    }, {
      record,
      ownerId: 'same-second-owner',
      ownerType: 'worker',
      signal: controller.signal
    })

    await started
    const { result: active } = await getJobByKey('same-second')
    assert.ok(active.endedAt < active.startedAt)

    const reason = new Error('test complete')
    reason.name = 'AbortError'
    controller.abort(reason)
    await running
  })
})
