import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import maintenanceStateSchema from '#models/maintenance-state/schema.js'
import trackUptime from '#models/job/jobs/track-uptime.js'

describe('Job: track-uptime', () => {
  beforeEach(async () => {
    try {
      await mdb.index('maintenanceStates').delete()
    } catch (_e) {
      // Ignore if not exists
    }
    // createIndex and updateSettings are auto-awaited by mdb wrapper
    await mdb.createIndex('maintenanceStates', { primaryKey: maintenanceStateSchema.primaryKey })
    await mdb.index('maintenanceStates').updateSettings(maintenanceStateSchema.settings)
  })

  after(async () => {
    try {
      await mdb.index('maintenanceStates').delete()
    } catch (_e) {}
  })

  it('should initialize a new uptime document if none exists', async () => {
    await trackUptime.run()

    const currentHour = Math.floor(Date.now() / (1000 * 60 * 60))
    const key = `uptime-${currentHour}`

    const doc = await mdb.index('maintenanceStates').getDocument(key)
    assert.equal(doc.count, 1)
    assert.equal(doc.type, 'uptime')
    assert.ok(doc.createdAt)
  })

  it('should increment count of existing uptime document', async () => {
    const currentHour = Math.floor(Date.now() / (1000 * 60 * 60))
    const key = `uptime-${currentHour}`

    // addDocuments is auto-awaited by mdb wrapper
    await mdb.index('maintenanceStates').addDocuments([{
      key,
      count: 5,
      type: 'uptime',
      createdAt: Date.now()
    }])

    await trackUptime.run()

    const doc = await mdb.index('maintenanceStates').getDocument(key)
    assert.equal(doc.count, 6)
  })

  it('should prune old uptime documents', async () => {
    const now = Date.now()
    const oldTime = now - (30 * 60 * 60 * 1000) // 30 hours ago
    const newTime = now - (1 * 60 * 60 * 1000) // 1 hour ago

    const docs = [
      { key: 'uptime-old-1', count: 1, type: 'uptime', createdAt: oldTime },
      { key: 'uptime-new-1', count: 1, type: 'uptime', createdAt: newTime }
    ]

    await mdb.index('maintenanceStates').addDocuments(docs)

    await trackUptime.run()

    // The run() function calls deleteDocuments which is auto-awaited by the wrapper,
    // so when run() returns, the deletion should be complete.

    // Check old is gone
    await assert.rejects(
      mdb.index('maintenanceStates').getDocument('uptime-old-1'),
      (err) => err.code === 'document_not_found' || err.cause?.code === 'document_not_found'
    )

    // Verify new exists
    const newDoc = await mdb.index('maintenanceStates').getDocument('uptime-new-1')
    assert.equal(newDoc.key, 'uptime-new-1')
  })
})
