import { describe, it, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import {
  getJobByKey,
  patchJobByKey,
  putJobByKey
} from '#models/job/dao.js'

describe('Job DAO', () => {
  const jobKey = 'test-job'
  const jobData = {
    key: jobKey,
    startedAt: Math.floor(Date.now() / 1000),
    requestedAt: Math.floor(Date.now() / 1000)
  }

  before(async () => {
    // Migration is already done by mdb.js init
    await mdb.index('jobs').deleteAllDocuments()
  })

  afterEach(async () => {
    await mdb.index('jobs').deleteAllDocuments()
  })

  it('putJobByKey should store a new job', async () => {
    const { success } = await putJobByKey(jobKey, jobData)
    assert.strictEqual(success, true)

    const { result: fetched } = await getJobByKey(jobKey)
    assert.strictEqual(fetched.key, jobKey)
    assert.strictEqual(fetched.startedAt, jobData.startedAt)
  })

  it('getJobByKey should return a job if it exists', async () => {
    await putJobByKey(jobKey, jobData)
    const { success, result } = await getJobByKey(jobKey)
    assert.strictEqual(success, true)
    assert.strictEqual(result.key, jobKey)
  })

  it('getJobByKey should return error if job does not exist', async () => {
    const { success, error, result } = await getJobByKey('non-existent')
    assert.strictEqual(success, false)
    assert.ok(error)
    assert.strictEqual(result, null)
  })

  it('patchJobByKey should update job metadata using Rhai function', async () => {
    await putJobByKey(jobKey, jobData)

    const endedAt = Math.floor(Date.now() / 1000) + 60
    const { success } = await patchJobByKey(jobKey, { endedAt })
    assert.strictEqual(success, true)

    const { result: updated } = await getJobByKey(jobKey)
    assert.strictEqual(updated.endedAt, endedAt)
    assert.strictEqual(updated.startedAt, jobData.startedAt)
  })

  it('patchJobByKey should return error if job not found', async () => {
    const { success, error } = await patchJobByKey('missing', { endedAt: 123 })
    assert.strictEqual(success, false)
    assert.strictEqual(error.message, 'Job not found')
  })
})
