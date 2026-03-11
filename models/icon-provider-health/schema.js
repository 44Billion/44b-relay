/**
 * MeiliSearch schema for tracking icon provider health.
 *
 * Each document represents one provider and records consecutive failures,
 * backoff expiry, and total lifetime stats.
 *
 * Primary key: provider name (e.g. 'wikipedia', 'wikidata', 'duckduckgo').
 */
export default {
  uid: 'iconProviderHealth',
  primaryKey: 'name',
  attributes: [
    'name',               // provider identifier (matches provider.name)
    'consecutiveFailures', // resets to 0 on success
    'backoffUntil',       // timestamp (ms) — skip this provider until this time
    'lastAttemptAt',      // timestamp (ms)
    'lastSuccessAt',      // timestamp (ms) or 0
    'totalSuccesses',     // lifetime counter
    'totalFailures',      // lifetime counter
    'lastError',          // truncated error message/stack of the last failure (or null)
    'erroredAt'           // timestamp (ms) of the last failure that set lastError (or null)
  ],
  settings: {
    displayedAttributes: ['*'],
    searchableAttributes: ['name'],
    filterableAttributes: [
      'name',
      'backoffUntil'
    ],
    sortableAttributes: []
  }
}
