import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mdb from '#services/db/mdb.js'
import reconcileJob from '#models/job/jobs/reconcile-used-bytes.js'
import { ipToPrimaryKey } from '#helpers/mdb.js'

describe('Job: Reconcile Used Bytes', () => {
  beforeEach(async () => {
    await Promise.all([
      mdb.index('events').deleteAllDocuments(),
      mdb.index('storedEventOwners').deleteAllDocuments()
    ])
  })

  it('should fix ghost usedBytes for pubkey owner (usedBytes > actual)', async () => {
    const pubkey = '0000000000000000000000000000000000000000000000000000000000000077'

    // Owner claims 5000 bytes but only has 1 event of 200 bytes
    await mdb.index('storedEventOwners').addDocuments([{
      key: pubkey,
      entityType: 'pubkey',
      usedBytes: 5000,
      popularityLevel: 2
    }])

    await mdb.index('events').addDocuments([{
      ref: 'ev1',
      id: 'ev1',
      pubkey,
      byteSize: 200,
      ownerType: 'pubkey',
      kind: 1, created_at: 100, content: '', sig: 'sig'
    }])

    await new Promise(resolve => setTimeout(resolve, 100))

    await reconcileJob.run()

    await new Promise(resolve => setTimeout(resolve, 100))

    const owner = await mdb.index('storedEventOwners').getDocument(pubkey)
    assert.equal(owner.usedBytes, 200, 'usedBytes should be corrected to actual sum (200)')
  })

  it('should fix ghost usedBytes for pubkey with 0 events', async () => {
    const pubkey = '0000000000000000000000000000000000000000000000000000000000000088'

    // Owner claims 12945 bytes but has 0 events (ghost usage)
    await mdb.index('storedEventOwners').addDocuments([{
      key: pubkey,
      entityType: 'pubkey',
      usedBytes: 12945,
      popularityLevel: 1
    }])

    await new Promise(resolve => setTimeout(resolve, 100))

    await reconcileJob.run()

    await new Promise(resolve => setTimeout(resolve, 100))

    const owner = await mdb.index('storedEventOwners').getDocument(pubkey)
    assert.equal(owner.usedBytes, 0, 'usedBytes should be corrected to 0 when no events exist')
  })

  it('should fix ghost usedBytes for IP owner', async () => {
    const ip = '10.20.30.40'
    const ipKey = ipToPrimaryKey(ip)

    // Owner claims 3000 bytes but only has 1 event of 100 bytes
    await mdb.index('storedEventOwners').addDocuments([{
      key: ipKey,
      entityType: 'ip',
      usedBytes: 3000,
      popularityLevel: 999
    }])

    await mdb.index('events').addDocuments([{
      ref: 'ip_ev1',
      id: 'ip_ev1',
      pubkey: 'somepk',
      ip,
      byteSize: 100,
      ownerType: 'ip',
      kind: 1, created_at: 100, content: '', sig: 'sig'
    }])

    await new Promise(resolve => setTimeout(resolve, 100))

    await reconcileJob.run()

    await new Promise(resolve => setTimeout(resolve, 100))

    const owner = await mdb.index('storedEventOwners').getDocument(ipKey)
    assert.equal(owner.usedBytes, 100, 'IP usedBytes should be corrected to actual sum (100)')
  })

  it('should not modify owners with correct usedBytes', async () => {
    const pubkey = '0000000000000000000000000000000000000000000000000000000000000055'

    await mdb.index('storedEventOwners').addDocuments([{
      key: pubkey,
      entityType: 'pubkey',
      usedBytes: 300,
      popularityLevel: 3
    }])

    await mdb.index('events').addDocuments([
      { ref: 'ev1', id: 'ev1', pubkey, byteSize: 100, ownerType: 'pubkey', kind: 1, created_at: 100, content: '', sig: 'sig' },
      { ref: 'ev2', id: 'ev2', pubkey, byteSize: 200, ownerType: 'pubkey', kind: 1, created_at: 200, content: '', sig: 'sig' }
    ])

    await new Promise(resolve => setTimeout(resolve, 100))

    await reconcileJob.run()

    await new Promise(resolve => setTimeout(resolve, 100))

    const owner = await mdb.index('storedEventOwners').getDocument(pubkey)
    assert.equal(owner.usedBytes, 300, 'usedBytes should remain 300 (already correct)')
  })

  it('config should have correct structure', () => {
    assert.equal(reconcileJob.key, 'reconcileUsedBytes')
    assert.equal(reconcileJob.manual, true)
    assert.equal(typeof reconcileJob.run, 'function')
  })
})
