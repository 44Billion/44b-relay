export const PRUNE_WORKFLOW_VERSION = 2
export const PRUNE_TARGET_RATIO = 0.9

export function getPruneTargetBytes (limit) {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(0, limit) : 0
  return normalizedLimit === 0
    ? 0
    : Math.floor(normalizedLimit * PRUNE_TARGET_RATIO)
}
