import { sendNotice } from '#helpers/message.js'
import { disconnectWhenInactive } from '#services/rate-limiting/web-socket-request-limiter.js'

class CloseHandler {
  static run ({ wss, ws, nostrMessage }) {
    return new this({ wss, ws, nostrMessage }).run()
  }

  constructor ({ wss, ws, nostrMessage }) {
    Object.assign(this, { wss, ws, nostrMessage })
  }

  async run () {
    const { ws, nostrMessage } = this
    const [, subscriptionId] = nostrMessage
    if (nostrMessage.length !== 2 || typeof subscriptionId !== 'string') {
      return sendNotice({ ws, message: 'invalid: malformed CLOSE' })
    }
    clearTimeout(ws.nostr.subscriptions[subscriptionId]?.cleanupTimeout)
    delete ws.nostr.subscriptions[subscriptionId]
    if (Object.keys(ws.nostr.subscriptions).length === 0) disconnectWhenInactive(ws)
  }
}

export default CloseHandler
