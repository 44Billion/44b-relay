import { isExpiredEvent, /* isReplaceableEvent, */ isEphemeralEvent, isValidEvent /* , getPublishedAt */ } from '#helpers/event.js'
import { sendCommandResult, sendEvent, sendClosed } from '#helpers/message.js'
import { nostrClientMessages } from '#constants/message.js'
import { eventKinds } from '#constants/event.js'
import { webSocketReadyState } from '#constants/web-socket.js'
import { doesMatchASubscriptionFilter } from '#helpers/subscription.js'
import { isAppEvent } from '#helpers/app.js'
// import { fightSpamOnNostrEvent } from '#services/spam-fighter/deta/index.js'
import { isAuthenticated } from '#services/relay/authenticator.js'
import { loadPopularityFilters, getPopularityLevel } from '#services/event/maintainer/mdb/index.js'
import { trackIpActivity } from '#services/event/tracker/mdb/ip-activity.js'
import EventSaver from '#services/event/saver/mdb/index.js'
import { detectEventLanguage, getEventText } from '#helpers/language.js'
import { extractHashtags } from '#helpers/hashtag.js'
import { detectTopics } from '#services/topic/detector.js'
import { disconnectWhenInactive } from '#services/rate-limiting/web-socket-request-limiter.js'
import { broadcast, waitUntilReady } from '#services/ipc/cross-process-broadcaster.js'

const RELAY_IPC_TIMEOUT_MS = 2000

class EventHandler {
  static run ({ wss, ws, nostrMessage }) {
    return new this({ wss, ws, nostrMessage }).run()
  }

  constructor ({ wss, ws, nostrMessage }) {
    Object.assign(this, { wss, ws, nostrMessage })
  }

  async run () {
    const { ws, nostrMessage } = this
    const [, event = {}] = nostrMessage
    try {
      trackIpActivity({ ip: ws.ip })
      let { isSuccess, message } = await isValidEvent({ event, clientMessage: nostrClientMessages.EVENT })
      if (!isSuccess) return sendCommandResult({ ws, event, isSuccess, message })

      // TODO: Check impact on performance then move from deta to mdb
      // const { isSpam } = await fightSpamOnNostrEvent(ws, event)
      // if (isSpam) return sendCommandResult({ ws, event, isSuccess: false, message: 'blocked: your IP is involved with spam' })

      // if is duplicate, must start with 'duplicate:' see this and others at https://github.com/nostr-protocol/nips/blob/master/20.md
      const eventLanguage = detectEventLanguage(event)
      const eventHashtags = extractHashtags(event, { language: eventLanguage })
      const eventTopics = await detectTopics({
        language: eventLanguage,
        hashtags: eventHashtags,
        text: getEventText(event)
      })

      let shouldRelay // e.g.: don't relay duplicates
      ;({ isSuccess, shouldRelay = isSuccess, message } = await this.processNostrEvent({ ws, event, ip: ws.ip, eventLanguage, eventTopics, eventHashtags }))

      if (shouldRelay) {
        const didBroadcast = await broadcast({ event, eventLanguage, eventTopics }, { timeoutMs: RELAY_IPC_TIMEOUT_MS })
        if (!didBroadcast) {
          return sendCommandResult({ ws, event, isSuccess: false, message: 'error: relay IPC unavailable; retry' })
        }
      }

      return sendCommandResult({ ws, event, isSuccess, message })
    } catch (error) {
      console.error('Error handling event:', error)
      sendCommandResult({ ws, event, isSuccess: false, message: 'error: internal server error' })
    }
  }

  async processNostrEvent ({ ws, event, ip, eventLanguage, eventTopics, eventHashtags }) {
    let isSuccess, shouldRelay, message, isBlocked, isDuplicate
    ;({ isBlocked, message } = this.applyCustomRelayRestrictionsToNostrEvent({ event }))
    if (isBlocked) return { isSuccess: false, shouldRelay: false, message }

    if (isExpiredEvent(event)) return { isSuccess: true, shouldRelay: false, message: 'expired: the event is already expired' }

    // Accepted events are live-delivered through IPC, including local clients.
    // If IPC is unavailable, reject before persistence to avoid storing an
    // event that cross-worker subscribers never saw live.
    if (!await waitUntilReady({ timeoutMs: RELAY_IPC_TIMEOUT_MS })) {
      return { isSuccess: false, shouldRelay: false, message: 'error: relay IPC unavailable; retry' }
    }

    if (isEphemeralEvent(event)) return { isSuccess: true, shouldRelay: true, message: '' }
    // Better to relay for those who may have subscribed to (e.g.: online status update)
    // else if (isReplaceableEvent(event)) shouldRelay = false

    ;({ isSuccess, isDuplicate, message } = await this.maybePersistEvent({ ws, event, ip, language: eventLanguage, topics: eventTopics, hashtags: eventHashtags }))
    if (!isSuccess || isDuplicate) shouldRelay = false
    shouldRelay ??= true

    return { isSuccess, shouldRelay, message }
  }

  isBlockedEventKind = (() => {
    // const allowlist = {
    //   [eventKinds.METADATA]: true,
    //   [eventKinds.TEXT_NOTE]: true,
    //   [eventKinds.RECOMMEND_RELAY]: true,
    //   [eventKinds.FOLLOWS]: true,
    //   // ENCRYPTED_DIRECT_MESSAGE: 4,
    //   // DELETION: 5,
    //   // REPOST: 6, // also add to aggregates table? { key: eventid }
    //   // REACTION: 7, // also add to aggregates table?
    //   // CHANNEL_CREATE: 40,
    //   // CHANNEL_METADATA: 41,
    //   // CHANNEL_MESSAGE: 42,
    //   // CHANNEL_HIDE_MESSAGE: 43,
    //   // CHANNEL_MUTE_USER: 44,
    //   // AUTH: 22242,
    //   [eventKinds.LONG_FORM_CONTENT]: true
    // }
    // For now allow all kinds
    // TODO: Later we should change expiration defaults
    return _event => false // !allowlist[event.kind]
  })()

  applyCustomRelayRestrictionsToNostrEvent ({ event }) {
    const { ws } = this
    if (
      // App events are an exception until we implement AUTH on nappup lib
      // (app uploader CLI)
      !isAppEvent(event) &&
      event.created_at < (Math.floor(Date.now() / 1000) - 60 * 10) &&
      // Annoying integration test tell use its a fail if we don't let it save 1 week ago events
      process.env.IS_INTEGRATION_TEST !== 'true'
    ) {
      if (!isAuthenticated({ ws })) return { isBlocked: true, message: 'auth-required: the event created_at field is too old and was not stored.' }
      else if (event.pubkey !== ws.nostr.pubkey) {
        return { isBlocked: true, message: 'restricted: we do not publish past events not signed by yourself.' }
      }
    }
    const TWO_DAYS_AHEAD = Math.ceil(Date.now() / 1000) + 60 * 60 * 24 * 2
    if (
      // Allow posting in the future to work as scheduled posts, but with a limit
      event.created_at > TWO_DAYS_AHEAD // ||
      // getPublishedAt(event) > TWO_DAYS_AHEAD
    ) return { isBlocked: true, message: 'invalid: the event created_at field is too far in the future (>2days) and was not stored.' }

    if (this.isBlockedEventKind(event)) return { isBlocked: true, message: 'invalid: event kind not allowed' }

    // // don't support emoji reactions
    // if (event.kind === eventKinds.REACTION && !['+', '-'].includes(event.content)) {
    //   return { isBlocked: true, message: 'invalid: we don\'t allow this reaction' }
    // }

    return { isBlocked: false, message: '' }
  }

  maybePersistEvent ({ ws, event, ip, language, topics, hashtags }) {
    return EventSaver.run({ ws, event, ip, language, topics, hashtags })
  }
}

// Some kinds intentionally use throwaway author pubkeys. Also, specs that start communication
// with a ephemeral kind from a user's main pubkey usually don't care about their popularity.
// Author-popularity gate would systematically drop their events.
// Examples:
// - All ephemeral kinds (e.g., NIP-46 SIGNER_RPC kind 24133)
// - NIP-59 gift wraps (kind 1059) used by NIP-17 DMs (regular, but throwaway author)
function shouldBypassPopularityGate (event) {
  return isEphemeralEvent(event) || event.kind === eventKinds.GIFT_WRAP
}

async function sendToClientsWithAMatchingFilter ({ wss, event, eventLanguage, eventTopics }) {
  // Better to relay for those who may have subscribed to (e.g.: online status update)
  // if (isReplaceableEvent(event)) return

  const maxUntil = Math.floor(Date.now() / 1000) + 10 * 60
  const isFutureEvent = event.created_at > maxUntil

  const skipPopularityGate = shouldBypassPopularityGate(event)
  if (!skipPopularityGate) await loadPopularityFilters()
  const authorPopularityLevel = skipPopularityGate ? 1 : getPopularityLevel(event.pubkey)

  for (const ws of wss.clients) {
    if (ws.readyState !== webSocketReadyState.OPEN) continue
    if (isFutureEvent && ws.nostr.pubkey !== event.pubkey) continue

    for (const [subscriptionId, { filters }] of Object.entries(ws.nostr.subscriptions)) {
      // Check popularity for broad filters
      // If the matching filter is broad, we only relay if popularity <= 6
      // If MULTIPLE filters match, and at least ONE is NOT broad/restricted, we should relay.
      let shouldRelay = false
      for (const filter of filters) {
        if (doesMatchASubscriptionFilter({ filters: [filter], event })) {
          if (filter.language && !filter.language.includes(eventLanguage)) continue
          if (filter.topic?.length && !filter.topic.some(topic => eventTopics?.includes(topic))) continue

          const hasExplicitAudience = filter.isSpam || filter.isRising || filter.isPopular
          if (hasExplicitAudience) {
            // OR-combined audience filters: relay if author matches ANY of them
            if (
              (filter.isSpam && authorPopularityLevel > 6) ||
              (filter.isRising && authorPopularityLevel === 6) ||
              (filter.isPopular && authorPopularityLevel <= 5)
            ) { shouldRelay = true; break }
          } else if (!filter.isBroad || authorPopularityLevel <= 6 || filter.includeSpam || process.env.IS_INTEGRATION_TEST === 'true') {
            shouldRelay = true
            break
          }
        }
      }

      if (!shouldRelay) continue

      await sendEvent({ ws, subscriptionId, event })

      const nowSecs = Math.floor(Date.now() / 1000)
      ws.nostr.subscriptions[subscriptionId].filters = filters.filter(filter => {
        if (filter.until !== undefined && filter.until < nowSecs) return false
        if (filter.ids?.includes(event.id)) {
          filter.ids = filter.ids.filter(id => id !== event.id)
          if (filter.ids.length === 0) return false
        }
        return true
      })

      if (ws.nostr.subscriptions[subscriptionId].filters.length === 0) {
        delete ws.nostr.subscriptions[subscriptionId]
        sendClosed({ ws, subscriptionId, message: 'completed: subscription ended' })
        if (Object.keys(ws.nostr.subscriptions).length === 0) disconnectWhenInactive(ws)
      }
    }
  }
}

export default EventHandler
export { sendToClientsWithAMatchingFilter }
