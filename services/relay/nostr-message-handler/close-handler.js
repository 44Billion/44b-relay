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
    delete ws.nostr.subscriptions[subscriptionId]
    if (Object.keys(ws.nostr.subscriptions).length === 0) disconnectWhenInactive(ws)
  }
}

export default CloseHandler
