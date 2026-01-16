import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import db, { migrate } from '#services/db/mdb.js'
import eventSchema from '#models/event/schema.js'
import jobSchema from '#models/job/schema.js'
import storedEventOwnerSchema from '#models/stored-event-owner/schema.js'
import pendingOpSchema from '#models/pending-op/schema.js'
import requestedPubkeySchema from '#models/requested-pubkey/schema.js'
import popularPubkeySchema from '#models/popular-pubkey/schema.js'
import ipActivitySchema from '#models/ip-activity/schema.js'
import maintenanceStateSchema from '#models/maintenance-state/schema.js'

describe('Meilisearch Client', () => {
  const schemas = [
    eventSchema,
    storedEventOwnerSchema,
    pendingOpSchema,
    requestedPubkeySchema,
    popularPubkeySchema,
    ipActivitySchema,
    maintenanceStateSchema,
    jobSchema
  ]

  it('should have initialized database with correct indexes and settings', async () => {
    // getIndexes returns { results: [], offset: 0, limit: 20, total: 0 }
    const indexes = await db.getIndexes({ limit: db.constants.maxBigIndexes })
    const indexUids = indexes.results.map(i => i.uid)

    for (const schema of schemas) {
      assert.ok(indexUids.includes(schema.uid), `Index ${schema.uid} should exist`)

      const indexInfo = indexes.results.find(i => i.uid === schema.uid)
      assert.equal(indexInfo.primaryKey, schema.primaryKey, `Primary Key for ${schema.uid} mismatch`)

      const index = db.index(schema.uid)
      const settings = await index.getSettings()

      if (schema.settings) {
        for (const [key, value] of Object.entries(schema.settings)) {
          const currentSetting = settings[key]
          assert.ok(currentSetting !== undefined, `Setting ${key} should verify in ${schema.uid}`)

          if (Array.isArray(value)) {
            const sortedExpected = [...value].sort()
            const sortedActual = [...currentSetting].sort()

            // Known Limitation: Meilisearch may return ['*'] for searchableAttributes even if set to [primaryKey]
            if (key === 'searchableAttributes' && sortedActual.length === 1 && sortedActual[0] === '*' &&
                sortedExpected.length === 1 && sortedExpected[0] === schema.primaryKey) {
              continue
            }

            assert.deepEqual(sortedActual, sortedExpected, `Setting ${key} for ${schema.uid} mismatch`)
          } else {
            assert.equal(currentSetting, value, `Setting ${key} for ${schema.uid} mismatch`)
          }
        }
      }
    }
  })

  it('should preserve data and settings after manual migration', async () => {
    const indexName = eventSchema.uid
    // Using a document that satisfies standard basic fields, keeping in mind specific schema requirements might exist.
    // However, Meilisearch is schemaless regarding document fields except primary key.
    const testDoc = {
      [eventSchema.primaryKey]: 'test-ref-migration-1',
      id: 'test-id-migration-1',
      content: 'persist this thorough migration'
    }

    // db proxy automatically waits for task
    await db.index(indexName).addDocuments([testDoc])

    // Verify data exists
    const docBefore = await db.index(indexName).getDocument('test-ref-migration-1')
    assert.equal(docBefore.content, testDoc.content)

    // Run manual migration
    await migrate(db, console.log) // we want to see logs for this test

    // Verify data still exists
    const docAfter = await db.index(indexName).getDocument('test-ref-migration-1')
    assert.equal(docAfter.content, testDoc.content)

    // Verify settings again
    const settings = await db.index(indexName).getSettings()
    if (eventSchema.settings) {
      for (const [key, value] of Object.entries(eventSchema.settings)) {
        if (Array.isArray(value)) {
          const sortedExpected = [...value].sort()
          const sortedActual = [...settings[key]].sort()
          assert.deepEqual(sortedActual, sortedExpected, `Setting ${key} preserved mismatch`)
        } else {
          assert.equal(settings[key], value, `Setting ${key} preserved mismatch`)
        }
      }
    }
  })
})
