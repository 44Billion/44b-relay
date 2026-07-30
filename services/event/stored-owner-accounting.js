import mdb from '#services/db/mdb.js'
import { checkpoint } from '#helpers/abort.js'

function isNotFound (error) {
  return error?.code === 'document_not_found' ||
    error?.cause?.code === 'document_not_found'
}

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

async function ensureStoredOwner (owner, { signal } = {}) {
  checkpoint(signal)
  let document
  try {
    document = await mdb.index('storedEventOwners').getDocument(owner.ownerKey)
  } catch (error) {
    if (!isNotFound(error)) throw error
    // Negative accounting against an already removed owner is a no-op. A
    // positive transfer must create its destination before applying the token.
    if (owner.delta < 0) return false
    await mdb.index('storedEventOwners').addDocuments([{
      key: owner.ownerKey,
      entityType: owner.ownerType,
      usedBytes: 0,
      popularityLevel: owner.popularityLevel ?? 999,
      accountingTokens: []
    }])
    document = { accountingTokens: [] }
  }

  if (!Array.isArray(document.accountingTokens)) {
    checkpoint(signal)
    // Initialize only while the field is absent. Replacing it with [] from a
    // stale read could erase a token written by another recoverable workflow.
    await mdb.index('storedEventOwners').updateDocumentsByFunction({
      function: `
        if doc.accountingTokens == () { doc.accountingTokens = []; }
        doc
      `,
      filter: `key = ${mdb.toMeiliValue(owner.ownerKey)}`
    })
  }
  return true
}

export async function applyStoredUsageDeltasOnce (
  deltas,
  operationKey,
  { signal } = {}
) {
  const aggregated = aggregateDeltas(deltas)
  for (const owner of aggregated) {
    checkpoint(signal)
    if (!await ensureStoredOwner(owner, { signal })) continue
    const token = `${operationKey}:${owner.ownerKey}`
    await mdb.index('storedEventOwners').updateDocumentsByFunction({
      function: `
        let seen = false;
        for existing in doc.accountingTokens {
          if existing == context.token { seen = true; }
        }
        if !seen {
          let next_bytes = doc.usedBytes + context.delta;
          if next_bytes < 0 { next_bytes = 0; }
          doc.usedBytes = next_bytes;
          doc.entityType = context.ownerType;
          if context.hasPopularityLevel {
            doc.popularityLevel = context.popularityLevel;
          }
          doc.accountingTokens.push(context.token);
        }
        doc
      `,
      filter: `key = ${mdb.toMeiliValue(owner.ownerKey)}`,
      context: {
        token,
        delta: owner.delta,
        ownerType: owner.ownerType,
        hasPopularityLevel: owner.popularityLevel !== undefined,
        popularityLevel: owner.popularityLevel ?? 999
      }
    })
  }
  return aggregated
}

export async function clearStoredUsageDeltaTokens (
  deltas,
  operationKey,
  { signal } = {}
) {
  const aggregated = aggregateDeltas(deltas)
  for (const owner of aggregated) {
    checkpoint(signal)
    const token = `${operationKey}:${owner.ownerKey}`
    try {
      await mdb.index('storedEventOwners').updateDocumentsByFunction({
        function: `
          let remaining = [];
          for existing in doc.accountingTokens {
            if existing != context.token { remaining.push(existing); }
          }
          doc.accountingTokens = remaining;
          doc
        `,
        filter: `key = ${mdb.toMeiliValue(owner.ownerKey)}`,
        context: { token }
      })
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
}

export { aggregateDeltas }
