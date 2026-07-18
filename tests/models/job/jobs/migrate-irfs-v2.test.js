import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import { eventToRecord } from '#models/event/mapper.js'
import { migrateIrfsV2 } from '#models/job/jobs/migrate-irfs-v2.js'
import { getManifestPoolUsage } from '#services/event/manifest-pool.js'

const pubkey = 'a'.repeat(64)
const rootA = '1'.repeat(64)
const rootB = '2'.repeat(64)

function record (idDigit, kind, tags, byteSize) {
  const event = {
    id: idDigit.repeat(64),
    pubkey,
    kind,
    tags,
    content: '',
    created_at: 100,
    sig: 'f'.repeat(128)
  }
  return {
    ...eventToRecord(event, { receivedAt: 100 }),
    byteSize,
    ownerType: 'pubkey',
    popularityLevel: 3
  }
}

describe('IRFS/MMR v2 one-time migration', () => {
  beforeEach(async () => {
    await Promise.all([
      mdb.index('events').deleteAllDocuments(),
      mdb.index('storedEventOwners').deleteAllDocuments(),
      mdb.index('manifestPoolUsage').deleteAllDocuments(),
      mdb.index('ipActivities').deleteAllDocuments(),
      mdb.index('maintenanceStates').deleteAllDocuments()
    ])
  })

  it('removes old listings and IRFS v1 while preserving generic 34600 and valid manifests', async () => {
    const listing = record('1', 37348, [['d', 'app']], 100)
    const oldIrfs = record('2', 35128, [
      ['d', 'old-irfs'],
      ['path', 'index.html', rootA],
      ['service', 'irfs']
    ], 200)
    const blossom = record('3', 35128, [
      ['d', 'blossom'],
      ['path', 'index.html', rootA],
      ['r', rootB, 'mark icon'],
      ['service', 'blossom']
    ], 300)
    const irfsV2 = record('4', 35129, [
      ['d', 'irfs-v2'],
      ['r', rootA, 'path index.html'],
      ['service', 'irfs']
    ], 400)
    const legacyGeneric = record('5', 34600, [], 500)
    const beyondIndexCap = record('6', 1, [
      ...Array.from({ length: 10 }, (_, index) => ['t', `tag${index}`]),
      ['r', rootB]
    ], 600)
    delete beyondIndexCap.blobRefs

    await mdb.index('events').addDocuments([
      listing, oldIrfs, blossom, irfsV2, legacyGeneric, beyondIndexCap
    ])
    await mdb.index('storedEventOwners').addDocuments([{
      key: pubkey,
      entityType: 'pubkey',
      usedBytes: 2100,
      popularityLevel: 3
    }])

    const result = await migrateIrfsV2()
    assert.equal(result.deletedListings, 1)
    assert.equal(result.deletedIrfsManifests, 1)
    assert.equal(result.migratedManifests, 2)

    await assert.rejects(mdb.index('events').getDocument(listing.ref))
    await assert.rejects(mdb.index('events').getDocument(oldIrfs.ref))
    assert.equal((await mdb.index('events').getDocument(legacyGeneric.ref)).kind, 34600)
    assert.deepEqual((await mdb.index('events').getDocument(blossom.ref)).blobRefs, [rootB])
    assert.deepEqual((await mdb.index('events').getDocument(beyondIndexCap.ref)).blobRefs, [rootB])

    const ordinaryUsage = await mdb.index('storedEventOwners').getDocument(pubkey)
    assert.equal(ordinaryUsage.usedBytes, 1100)
    const pool = await getManifestPoolUsage()
    assert.equal(pool.global.logicalBytes, 700)
    assert.equal(pool.global.manifestCount, 2)

    const secondRun = await migrateIrfsV2()
    assert.equal(secondRun.alreadyCompleted, true)
  })
})
