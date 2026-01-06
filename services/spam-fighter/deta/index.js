import deta from '#services/db/deta.js'
import { eventKinds } from '#constants/event.js'
import { getUrls } from '#helpers/string.js'
import { toUrlId } from '#helpers/url.js'

// This checks url spamming (like url ads)
// Other possible techniques:
// - content hashing then counting as done with urls (won't work cause spammers add bogus chars to change hash)
// - word filter (sort of work for bad words, but do we really want to ban bad words? and won't fight ads)
// - incrementing PoW requirement if caught by rate limiter (PoW is bad as real clients aren't prepared, but only when rate limited may be good)
// |-> add x requirement depending of at what rate limiter it was blocked (the higher minutes limiter adds greater PoW for 30min + limited time?)
async function fightSpamOnNostrEvent (ws, event) {
  const { ip } = ws
  const urls = extractNormalizedUrls(event, { howMany: 31 }) // get from content and [0] mentions if url
  if (urls.length === 0) return { isSpam: false }
  const isSpam = urls.length > 30
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async resolve => {
    try {
      if (isSpam) resolve({ isSpam })

      let url
      // can't do await db.putMany() because util.increment() would always become 1, so must use individual .update
      for (url of urls) {
        const key = `${ip}:${url}`
        const update = { count: deta.Base('ipUrls').util.increment(), __expires: Date.now() / 1000 + 60 * 5 }
        try {
          await deta.Base('ipUrls').update(update, key)
        } catch (err) {
          await deta.Base('ipUrls').put(update, key)
        }
        const { count } = await deta.Base('ipUrls').get(key) || { count: 0 }
        if (!isSpam && count > 3) {
          resolve({ isSpam: true }) // resolve and keep running on bg
        }
      }
    } catch (err) {
      console.log(err.stack)
    } finally {
      resolve({ isSpam })
    }
  })
}

function extractNormalizedUrls (event, { howMany }) {
  if (![eventKinds.TEXT_NOTE, eventKinds.CHANNEL_MESSAGE, eventKinds.LONG_FORM_CONTENT].includes(event.kind)) return []
  if (!event.content) return []

  return getUrls(event.content, { howMany, fallbackProtocol: 'https://' })
    .map(url => toUrlId(url))
    .filter(Boolean)
}

export { fightSpamOnNostrEvent }
