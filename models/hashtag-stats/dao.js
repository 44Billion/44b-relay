/**
 * DAO for hashtagStats index operations.
 */
import mdb from '#services/db/mdb.js'

// Rhai script used to patch a map of key->icon values onto hashtagStats documents.
// For each document with a key in the map, sets doc.icon to the mapped value.
const PATCH_ICONS_RHAI = 'if doc.key in context.iconByKey { doc.icon = context.iconByKey[doc.key] } doc'

/**
 * Patches the `icon` field on multiple hashtagStats documents in a single call.
 * Only updates documents that already exist (no phantom inserts).
 *
 * @param {Record<string, string>} iconByKey - map of hashtagStats key (e.g., 'en-bitcoin') -> icon URL
 * @returns {Promise<void>}
 */
export async function patchIcons (iconByKey) {
  const keys = Object.keys(iconByKey)
  if (keys.length === 0) return

  const keyFilters = keys
    .map(k => `key = ${mdb.toMeiliValue(k)}`)
    .join(' OR ')

  await mdb.index('hashtagStats').updateDocumentsByFunction({
    function: PATCH_ICONS_RHAI,
    filter: keyFilters,
    context: { iconByKey }
  })
}
