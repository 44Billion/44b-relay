import { isExpiredEvent, isReplaceableEvent, isEphemeralEvent, isValidEvent, getPublishedAt } from '#helpers/event.js'
import { sendCommandResult, sendEvent } from '#helpers/message.js'
import { nostrClientMessages } from '#constants/message.js'
import { eventKinds } from '#constants/event.js'
import { webSocketReadyState } from '#constants/web-socket.js'
import { doesMatchASubscriptionFilter } from '#helpers/subscription.js'
import { fightSpamOnNostrEvent } from '#services/spam-fighter/index.js'
import EventSaver from '#services/event/saver.js'

class EventHandler {
  static run ({ wss, ws, nostrMessage }) {
    return new this({ wss, ws, nostrMessage }).run()
  }

  constructor ({ wss, ws, nostrMessage }) {
    Object.assign(this, { wss, ws, nostrMessage })
  }

  async run () {
    const { wss, ws, nostrMessage } = this
    const [, event = {}] = nostrMessage
    let { isSuccess, message } = await isValidEvent({ event, clientMessage: nostrClientMessages.EVENT })
    if (!isSuccess) return sendCommandResult({ ws, event, isSuccess, message })

    const { isSpam } = await fightSpamOnNostrEvent(ws, event)
    if (isSpam) return sendCommandResult({ ws, event, isSuccess: false, message: 'blocked: your IP is involved with spam' })

    // if is duplicate, must start with 'duplicate:' see this and others at https://github.com/nostr-protocol/nips/blob/master/20.md
    let shouldRelay // e.g.: don't relay duplicates
    ;({ isSuccess, shouldRelay = isSuccess, message } = await this.processNostrEvent({ ws, event, ip: ws.ip }))
    sendCommandResult({ ws, event, isSuccess, message })
    if (shouldRelay) return this.sendToClientsWithAMatchingFilter({ wss, event })
  }

  async processNostrEvent ({ ws, event, ip }) {
    let isSuccess, shouldRelay, message, isBlocked, isDuplicate
    ;({ isBlocked, message } = this.applyCustomRelayRestrictionsToNostrEvent({ event }))
    if (isBlocked) return { isSuccess: false, shouldRelay: false, message }

    if (isExpiredEvent(event)) return { isSuccess: true, shouldRelay: false, message: 'expired: the event is already expired' }
    if (isEphemeralEvent(event)) return { isSuccess: true, shouldRelay: true, message: '' }
    // Better to relay for those who may have subscribed to (e.g.: online status update)
    // else if (isReplaceableEvent(event)) shouldRelay = false

    ;({ isSuccess, isDuplicate, message } = await this.maybePersistEvent({ ws, event, ip }))
    if (!isSuccess || isDuplicate) shouldRelay = false
    shouldRelay ??= true

    return { isSuccess, shouldRelay, message }
  }

  isBlockedEventKind = (() => {
    const allowlist = {
      [eventKinds.METADATA]: true,
      [eventKinds.TEXT_NOTE]: true,
      [eventKinds.RECOMMEND_RELAY]: true,
      [eventKinds.FOLLOWS]: true,
      // ENCRYPTED_DIRECT_MESSAGE: 4,
      // DELETION: 5,
      // REPOST: 6, // also add to aggregates table? { key: eventid }
      // REACTION: 7, // also add to aggregates table?
      // CHANNEL_CREATE: 40,
      // CHANNEL_METADATA: 41,
      // CHANNEL_MESSAGE: 42,
      // CHANNEL_HIDE_MESSAGE: 43,
      // CHANNEL_MUTE_USER: 44,
      // AUTH: 22242,
      [eventKinds.LONG_FORM_CONTENT]: true
    }
    return event => !allowlist[event.kind]
  })()

  applyCustomRelayRestrictionsToNostrEvent ({ event }) {
    const { ws } = this
    if (event.pubkey !== ws.nostr.pubkey) return { isBlocked: true, message: 'invalid: we do not publish events not signed by yourself' }

    // NIP-22: Event created_at Limits - https://github.com/nostr-protocol/nips/blob/master/22.md
    if (
      event.created_at < (Math.floor(Date.now / 1000) - 60 * 60 * 10) ||
      event.created_at > (Math.ceil(Date.now / 1000) + 60 * 60 * 10) ||
      getPublishedAt(event) > (Math.ceil(Date.now / 1000) + 60 * 60 * 10)
    ) return { isBlocked: true, message: 'invalid: the event created_at field is out of the acceptable range (-10min, +10min) for this relay and was not stored.' }

    if (this.isBlockedEventKind(event)) return { isBlocked: true, message: 'invalid: event kind not allowed' }

    // don't support emoji reactions
    if (event.kind === eventKinds.REACTION && !['+', '-'].includes(event.content)) {
      return { isBlocked: true, message: 'invalid: we don\'t allow this reaction' }
    }

    return { isBlocked: false, message: '' }
  }

  async sendToClientsWithAMatchingFilter ({ wss, event }) {
    if (isReplaceableEvent(event)) return

    for (const ws of wss.clients) {
      if (ws.readyState !== webSocketReadyState.OPEN) return
      const subscriptionIds = Object.entries(ws.nostr.subscriptions)
        .filter(([, { filters }]) => doesMatchASubscriptionFilter({ filters, event }))
        .map(([k]) => k)

      for (const subscriptionId of subscriptionIds) {
        await sendEvent({ ws, subscriptionId, event })
      }
    }
  }

  maybePersistEvent ({ ws, event, ip }) {
    return EventSaver.run({ ws, event, ip })
  }
}

export default EventHandler
