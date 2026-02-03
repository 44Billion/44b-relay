import { sendNotice, sendCommandResult } from '#helpers/message.js'
import { nostrClientMessages } from '#constants/message.js'
import AuthHandler from './auth-handler.js'
import EventHandler from './event-handler.js'
import ReqHandler from './req-handler.js'
import CloseHandler from './close-handler.js'
import {
  rateLimitNostrMessageByPubkey,
  rateLimitNostrAuthMessageByPubkey,
  rateLimitNostrReqMessageByWsConnection,
  rateLimitNostrReqMessageByPubkey,
  rateLimitNostrEventMessageByPubkey
} from '#services/rate-limiting/nostr-message-limiter.js'
// import { isAuthenticated } from '#services/relay/authenticator.js'
import { imageDataUrlRegExp } from '#constants/url.js'
import { eventKinds } from '#constants/event.js'

class NostrMessageHandler {
  constructor ({ wss, ws, nostrMessage }) {
    Object.assign(this, { wss, ws, nostrMessage })
  }

  run () {
    const { wss, ws, nostrMessage } = this

    if (!nostrMessage) return sendNotice({ ws, message: 'error: failed to parse Nostr message' })

    // Here on top instead of below keeps the connection alive, even if it gets rate limited
    ws.nostr.lastActiveAtMs = Date.now()

    // TODO: assess https://github.com/nostr-protocol/nips/issues/177
    // "[...] (to) remove the key-weakening concern of mined public keys,
    // A relay could require keys to be whitelisted in order to write events.
    // Anybody who sends in an event with POW (not the pubkey itself) beyond
    // a certain threshold is automatically whitelisted, unless or until blacklisted due to abuse."
    // What about if within an AUTH event, so that the PoW must be generated
    // at that moment for that event, rather than a pre computed PoW?
    const { isBlocked } = this.applyCustomRelayRestrictionsToNostrMessage({ wss, ws, nostrMessage })
    if (isBlocked) return

    const handleFn = nostMessageHandlers[nostrMessage[0]]
    if (!handleFn) return

    handleFn({ wss, ws, nostrMessage })
  }

  applyCustomRelayRestrictionsToNostrMessage ({ wss, ws, nostrMessage }) {
    // Maybe don't let someone elses events be added
    // As down side one would not be able to mirror event it is reacting to for instance
    // In fact, we won't require authentication anymore as it's bad for privacy
    // const { isRestricted } = restrictUnauthenticatedMessage({ ws, nostrMessage })
    // if (isRestricted) return { isBlocked: true }
    const { isRateLimited } = rateLimitNostrMessage({ wss, ws, nostrMessage })
    if (isRateLimited) return { isBlocked: true }
    const { isInvalid } = limitNostrMessageLength({ ws, nostrMessage })
    if (isInvalid) return { isBlocked: true }
    return { isBlocked: false }
  }
}

const nostMessageHandlers = {
  [nostrClientMessages.AUTH] ({ wss, ws, nostrMessage }) { return AuthHandler.run({ wss, ws, nostrMessage }) },
  [nostrClientMessages.EVENT] ({ wss, ws, nostrMessage }) { return EventHandler.run({ wss, ws, nostrMessage }) },
  [nostrClientMessages.REQ] ({ wss, ws, nostrMessage }) { return ReqHandler.run({ wss, ws, nostrMessage }) },
  [nostrClientMessages.CLOSE] ({ wss, ws, nostrMessage }) { return CloseHandler.run({ wss, ws, nostrMessage }) }
}

export function limitNostrMessageLength ({ ws, nostrMessage }) {
  const nostrClientMessage = nostrMessage[0]
  const { byteLength: msgByteLength } = nostrMessage
  let event
  let isInvalid
  switch (nostrClientMessage) {
    case nostrClientMessages.REQ: {
      const authorByteLength = 64
      // we slice 500 authors at parseSubscriptionFilter
      // keep 10 max filters per pubkey
      // and add extra space for other keys
      isInvalid = msgByteLength > (authorByteLength * 500 * 10 + 1024)
      break
    }
    case nostrClientMessages.EVENT: {
      ([, event = {}] = nostrMessage)
      if (event?.kind || event?.kind === 0) {
        if (eventKinds.TEXT_NOTE === event.kind) {
          if (typeof event.content === 'string') {
            // expect max 1 image data url, so no g flag
            const contentWithoutDataImage = event.content.replace(imageDataUrlRegExp, '')
            const contentByteLength = new TextEncoder().encode(contentWithoutDataImage).byteLength
            isInvalid = contentByteLength > 8 * 1024
          } else {
            isInvalid = true
          }
        } else if (event.kind === eventKinds.ENCRYPTED_DIRECT_MESSAGE) {
          // won't allow image data url
          isInvalid = typeof event.content !== 'string' || msgByteLength > 4 * 1024
        } else if (event.kind === eventKinds.BINARY_DATA_CHUNK) {
          if (typeof event.content === 'string') {
            // Minimum Length: 58,286 bytes (all zeros)
            // Maximum Length: 62,770 bytes (all ones)
            const contentByteLength = new TextEncoder().encode(event.content).byteLength
            isInvalid = contentByteLength > 62770 || (isntLastChunk(event.tags) && contentByteLength < 58286)
            if (isInvalid) console.log(`Binary data chunk event with invalid content length: ${contentByteLength} bytes`)
          } else {
            isInvalid = true
          }
        } else if (
          [
            eventKinds.FOLLOWS,
            eventKinds.MAIN_APP_BUNDLE,
            eventKinds.NEXT_APP_BUNDLE,
            eventKinds.DRAFT_APP_BUNDLE
          ].includes(event.kind)
        ) {
          // A FOLLOWS event with 1000 p tags (NIP-02) can take up to ~128 KB
          // assuming each tag has a pubkey, relay URL, and petname.
          isInvalid = msgByteLength > 128 * 1024
        } else {
          // https://github.com/hoytech/strfry/blob/master/strfry.conf#L21
          // maxEventSize = 65536
          isInvalid = msgByteLength > 4 * 1024
        }
      }
      break
    }
  }
  if (!isInvalid) return { isInvalid: false }

  sendCommandResult({ ws, event, isSuccess: false, message: 'invalid: message is too long' })
  return { isInvalid: true }
}

// const currentCtag = `${chunk.rootX}:${chunk.index}`
// ['c', currentCtag, chunk.length, ...chunk.proof],
function isntLastChunk (tags = []) {
  const cTags = tags.filter(tag => tag[0] === 'c' && typeof tag[1] === 'string' && tag[2] !== undefined)

  if (cTags.length === 0) return true

  const isAnyLast = cTags.some(tag => {
    const cTagValue = tag[1]
    const totalChunks = parseInt(tag[2], 10)
    const parts = cTagValue.split(':')
    const index = parseInt(parts[parts.length - 1], 10)

    return !isNaN(index) && !isNaN(totalChunks) && index === totalChunks - 1
  })

  return !isAnyLast
}

// function restrictUnauthenticatedMessage ({ ws, nostrMessage }) {
//   if (isAuthenticated({ ws })) return { isBlocked: false }

//   let event
//   let message
//   const nostrClientMessage = nostrMessage[0]

//   switch (nostrClientMessage) {
//     case nostrClientMessages.EVENT:
//       ([, event = {}] = nostrMessage)
//       message = 'we do not accept events from unauthenticated users'
//       break
//     case nostrClientMessages.REQ: // we need this, cause we will limit sub count by pubkey (by ip will be higher)
//       event = {}
//       message = 'we do not accept subscriptions from unauthenticated users'
//       break
//   }
//   if (!message) return { isBlocked: false }

//   sendCommandResult({ ws, event, isSuccess: false, message: `restricted: ${message}` })
//   return { isBlocked: true }
// }

function rateLimitNostrMessage ({ wss, ws, nostrMessage }) {
  const nostrClientMessage = nostrMessage[0]
  const event = nostrClientMessage === nostrClientMessages.EVENT ? nostrMessage[1] : {}

  let { isRateLimited } = rateLimitNostrMessageByPubkey(ws)
  if (isRateLimited) {
    sendCommandResult({ ws, event, isSuccess: false, message: 'rate-limited: slow down there chief' })
    return { isRateLimited }
  }

  let message
  switch (nostrClientMessage) {
    case nostrClientMessages.AUTH:
      ({ isRateLimited } = rateLimitNostrAuthMessageByPubkey(ws))
      if (isRateLimited) message = 'slow down there chief'
      break
    case nostrClientMessages.REQ: {
      const [, subscriptionId, ...filters] = nostrMessage
      ;({ isRateLimited } = rateLimitNostrReqMessageByWsConnection(ws, subscriptionId))
      if (isRateLimited) message = 'slow down there chief'
      else {
        ;({ isRateLimited } = rateLimitNostrReqMessageByPubkey(wss, ws, subscriptionId, filters))
        if (isRateLimited) message = 'slow down there chief'
      }
      break
    }
    case nostrClientMessages.EVENT: {
      const event = nostrMessage[1] ?? {}
      ;({ isRateLimited } = rateLimitNostrEventMessageByPubkey(ws, event))
      if (isRateLimited) message = 'slow down there chief'
      break
    }
  }

  if (!message) return { isRateLimited: false }

  sendCommandResult({ ws, event, isSuccess: false, message: `rate-limited: ${message}` })
  return { isRateLimited: true }
}
// https://github.com/nostr-protocol/nips/issues/177
// PoW for unauthenticated
// Network-bound https://en.wikipedia.org/wiki/Proof_of_work#cite_note-Abliz09-14 (proof of interaction same thing? https://arxiv.org/pdf/2002.07763.pdf)
// WHAT if ip sends from different pubkeys? <- POW!
// network pow?
// 8 * 3 / ip / 20 secs
// 7 * 3 / ip / 15 secs
// 5 * 2 / ip / 10 secs
// 4 * 2 / ip / 5 secs
// 3 * 2 / ip / sec (global limiter)
// 5 / pubkey / sec
// 3 CHANNEL_CREATE / day
// 75 TEXT_NOTE EVENT / pubkey / day
// 75 * 5 ENCRYPTED_DIRECT_MESSAGE/CHANNEL_MESSAGE EVENT / pubkey / day
// above are not exponencial
// we need exponencial rate limiter? yes for pubkey! (each below rate limiter may temporaly increase window * 2)
// 27 EVENT / pubkey / 5 min
// 20 EVENT / pubkey / 2 min
// 15 EVENT / pubkey / min
// 10 EVENT / pubkey / 10 sec
// 3 EVENT / pubkey / sec
// below are not rate limiters
// 10 * 15 filters / ip / anytime (sub with 2 filters count as 2)
// 10 filters / pubkey / anytime (if authenticated, as read only clients won't authenticate)

export default NostrMessageHandler
