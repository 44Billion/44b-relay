import NMMR from 'nmmr'
import { decode } from 'libp2r2p/base93'

export const IRFS_CHUNK_BYTES = 51000

// Validates every signed field that participates in an IRFS v2 chunk.
export function validateIrfsChunkEvent (event) {
  if (!event || event.kind !== 34601 || !Array.isArray(event.tags) || typeof event.content !== 'string') {
    throw new Error('wrong chunk event')
  }
  const dTags = event.tags.filter(tag => Array.isArray(tag) && tag[0] === 'd')
  const mmrTags = event.tags.filter(tag => Array.isArray(tag) && tag[0] === 'mmr')
  if (dTags.length !== 1 || dTags[0].length !== 2 || !/^[0-9a-f]{64}$/.test(dTags[0][1])) {
    throw new Error('wrong chunk d tag')
  }
  if (mmrTags.length !== 1 || mmrTags[0].length !== 4) throw new Error('wrong chunk mmr tag')

  const [, indexText, totalText, proofText] = mmrTags[0]
  const contentBytes = decode(event.content)
  const proof = decode(proofText)
  const mmrRoot = NMMR.calculateRoot({ contentBytes, index: indexText, total: totalText, proof })
  const mmrIndex = Number(indexText)
  const mmrTotal = Number(totalText)
  if (contentBytes.length < 1 || contentBytes.length > IRFS_CHUNK_BYTES ||
      (mmrIndex < mmrTotal - 1 && contentBytes.length !== IRFS_CHUNK_BYTES)) {
    throw new Error('wrong chunk byte length')
  }
  if (NMMR.deriveChunkId(mmrRoot, indexText) !== dTags[0][1]) throw new Error('chunk d tag mismatch')
  return { mmrRoot, mmrIndex, mmrTotal }
}
