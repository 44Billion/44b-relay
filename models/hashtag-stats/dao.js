/**
 * DAO for hashtagStats index operations.
 */
import mdb from '#services/db/mdb.js'

// Rhai script used to patch a map of key->icon values onto hashtagStats documents.
// For each document with a key in the map, sets doc.icon and doc.iconCachedAt.
const PATCH_ICONS_RHAI = 'if doc.key in context.iconByKey { doc.icon = context.iconByKey[doc.key]; doc.iconCachedAt = context.now } doc'

const PATCH_ICONS_BATCH_SIZE = 5

/**
 * Patches the `icon` and `iconCachedAt` fields on multiple hashtagStats documents.
 * Only updates documents that already exist (no phantom inserts).
 * Processes in small batches to avoid oversized payloads (icons may be large data URLs).
 *
 * @param {Record<string, string>} iconByKey - map of hashtagStats key (e.g., 'en-bitcoin') -> icon URL
 * @returns {Promise<void>}
 */
export async function patchIcons (iconByKey) {
  const keys = Object.keys(iconByKey)
  if (keys.length === 0) return

  const now = Date.now()

  for (let i = 0; i < keys.length; i += PATCH_ICONS_BATCH_SIZE) {
    const batchKeys = keys.slice(i, i + PATCH_ICONS_BATCH_SIZE)
    const batchIconByKey = Object.fromEntries(batchKeys.map(k => [k, iconByKey[k]]))

    const keyFilters = batchKeys
      .map(k => `key = ${mdb.toMeiliValue(k)}`)
      .join(' OR ')

    await mdb.index('hashtagStats').updateDocumentsByFunction({
      function: PATCH_ICONS_RHAI,
      filter: keyFilters,
      context: { iconByKey: batchIconByKey, now }
    })
  }
}
