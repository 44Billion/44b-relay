import mdb from '#services/db/mdb.js'
import { checkpoint } from '#helpers/abort.js'

function aggregateDeltas (deltas) {
  const aggregated = new Map()
  for (const delta of deltas) {
    if (!delta?.ownerKey || !Number.isFinite(delta.delta) || delta.delta === 0) {
      continue
    }
    const current = aggregated.get(delta.ownerKey) || {
      ownerKey: delta.ownerKey,
      ownerType: delta.ownerType === 'ip' ? 'ip' : 'pubkey',
      popularityLevel: delta.popularityLevel,
      delta: 0
    }
    current.delta += delta.delta
    if (delta.popularityLevel !== undefined) {
      current.popularityLevel = delta.popularityLevel
    }
    aggregated.set(delta.ownerKey, current)
  }
  return [...aggregated.values()].filter(delta => delta.delta !== 0)
}

function ownersFilter (owners) {
  return `key IN [${owners
    .map(owner => mdb.toMeiliValue(owner.ownerKey))
    .join(', ')}]`
}

async function prepareStoredOwners (owners, { signal } = {}) {
  if (!owners.length) return []
  checkpoint(signal)
  const { results } = await mdb.index('storedEventOwners').getDocuments({
    filter: ownersFilter(owners),
    fields: ['key'],
    limit: owners.length
  })
  const existingKeys = new Set(results.map(owner => owner.key))
  const missingPositive = owners.filter(owner =>
    owner.delta > 0 && !existingKeys.has(owner.ownerKey)
  )

  if (missingPositive.length) {
    checkpoint(signal)
    await mdb.index('storedEventOwners').addDocuments(
      missingPositive.map(owner => ({
        key: owner.ownerKey,
        entityType: owner.ownerType,
        usedBytes: 0,
        popularityLevel: owner.popularityLevel ?? 999,
        accountingTokens: []
      }))
    )
  }

  return owners.filter(owner =>
    existingKeys.has(owner.ownerKey) || owner.delta > 0
  )
}

function accountingEntries (owners, operationKey) {
  return owners.map(owner => ({
    ownerKey: owner.ownerKey,
    token: `${operationKey}:${owner.ownerKey}`,
    delta: owner.delta,
    ownerType: owner.ownerType,
    hasPopularityLevel: owner.popularityLevel !== undefined,
    popularityLevel: owner.popularityLevel ?? 999
  }))
}

export async function applyStoredUsageDeltasOnce (
  deltas,
  operationKey,
  { signal } = {}
) {
  const aggregated = aggregateDeltas(deltas)
  const owners = await prepareStoredOwners(aggregated, { signal })
  if (!owners.length) return aggregated

  checkpoint(signal)
  await mdb.index('storedEventOwners').updateDocumentsByFunction({
    function: `
      if doc.accountingTokens == () { doc.accountingTokens = []; }
      if doc.usedBytes == () { doc.usedBytes = 0; }
      for entry in context.entries {
        if doc.key == entry.ownerKey {
          let seen = false;
          for existing in doc.accountingTokens {
            if existing == entry.token { seen = true; }
          }
          if !seen {
            let next_bytes = doc.usedBytes + entry.delta;
            if next_bytes < 0 { next_bytes = 0; }
            doc.usedBytes = next_bytes;
            doc.entityType = entry.ownerType;
            if entry.hasPopularityLevel {
              doc.popularityLevel = entry.popularityLevel;
            }
            doc.accountingTokens.push(entry.token);
          }
        }
      }
      doc
    `,
    filter: ownersFilter(owners),
    context: { entries: accountingEntries(owners, operationKey) }
  })
  return aggregated
}

export async function clearStoredUsageDeltaTokens (
  deltas,
  operationKey,
  { signal } = {}
) {
  const aggregated = aggregateDeltas(deltas)
  if (!aggregated.length) return

  checkpoint(signal)
  await mdb.index('storedEventOwners').updateDocumentsByFunction({
    function: `
      if doc.accountingTokens != () {
        for entry in context.entries {
          if doc.key == entry.ownerKey {
            let remaining = [];
            for existing in doc.accountingTokens {
              if existing != entry.token { remaining.push(existing); }
            }
            doc.accountingTokens = remaining;
          }
        }
      }
      doc
    `,
    filter: ownersFilter(aggregated),
    context: { entries: accountingEntries(aggregated, operationKey) }
  })
}

export { aggregateDeltas }
