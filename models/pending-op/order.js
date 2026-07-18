export const PENDING_OPS_SORT = Object.freeze([
  'createdAt:asc',
  'batchId:asc',
  'position:asc',
  'key:asc'
])

export const PENDING_OPS_REVERSE_SORT = Object.freeze([
  'createdAt:desc',
  'batchId:desc',
  'position:desc',
  'key:desc'
])

export function comparePendingOps (a, b) {
  const createdAt = (a.createdAt || 0) - (b.createdAt || 0)
  if (createdAt) return createdAt
  const aBatchId = String(a.batchId || '')
  const bBatchId = String(b.batchId || '')
  const batchId = aBatchId < bBatchId ? -1 : aBatchId > bBatchId ? 1 : 0
  if (batchId) return batchId
  const position = (a.position || 0) - (b.position || 0)
  if (position) return position
  const aKey = String(a.key || '')
  const bKey = String(b.key || '')
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
}
