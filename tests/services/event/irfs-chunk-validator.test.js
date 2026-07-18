import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import NMMR from 'nmmr'
import { encode } from 'libp2r2p/base93'
import { validateIrfsChunkEvent } from '#services/event/irfs-chunk-validator.js'

async function createEvents (contents) {
  const mmr = new NMMR()
  for (const content of contents) await mmr.append(content)
  const root = mmr.getRoot()
  const events = []
  for await (const chunk of mmr.getChunks()) {
    events.push({
      kind: 34601,
      tags: [
        ['d', NMMR.deriveChunkId(root, chunk.index)],
        ['mmr', String(chunk.index), String(chunk.total), encode(chunk.proof)]
      ],
      content: encode(chunk.contentBytes)
    })
  }
  return { root, events }
}

describe('IRFS chunk validator', () => {
  it('validates one-chunk blobs with an empty proof and derives metadata', async () => {
    const { root, events } = await createEvents([new Uint8Array([1, 2, 3])])
    assert.equal(events[0].tags[1][3], '')
    assert.deepEqual(validateIrfsChunkEvent(events[0]), {
      mmrRoot: root,
      mmrIndex: 0,
      mmrTotal: 1
    })
  })

  it('validates full non-final chunks and a short final chunk', async () => {
    const { root, events } = await createEvents([
      new Uint8Array(51000).fill(1),
      new Uint8Array([2])
    ])
    assert.equal(validateIrfsChunkEvent(events[0]).mmrRoot, root)
    assert.equal(validateIrfsChunkEvent(events[1]).mmrRoot, root)
  })

  it('rejects a short non-final chunk even when its MMR proof is valid', async () => {
    const { events } = await createEvents([new Uint8Array([1]), new Uint8Array([2])])
    assert.throws(() => validateIrfsChunkEvent(events[0]), /byte length/)
  })

  it('rejects duplicate tags, a changed d, non-canonical numbers and bad Base93', async () => {
    const { events } = await createEvents([new Uint8Array([1])])
    const event = events[0]

    assert.throws(() => validateIrfsChunkEvent({ ...event, tags: [...event.tags, event.tags[0]] }), /d tag/)
    assert.throws(() => validateIrfsChunkEvent({
      ...event,
      tags: [['d', '0'.repeat(64)], event.tags[1]]
    }), /mismatch/)
    assert.throws(() => validateIrfsChunkEvent({
      ...event,
      tags: [event.tags[0], ['mmr', '00', '1', '']]
    }), /canonical/)
    assert.throws(() => validateIrfsChunkEvent({ ...event, content: '\n' }), /Base93|character|alphabet/i)
  })
})
