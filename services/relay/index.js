import { nostrClientMessages } from '#constants/message.js'
import NostrMessageHandler from './nostr-message-handler/index.js'
import { requestAuthentication } from '#services/relay/authenticator.js'
import { disconnectWhenInactive } from '#services/rate-limiting/web-socket-request-limiter.js'

class Relay {
  constructor ({ wss }) {
    Object.assign(this, { wss })
  }

  handleConnection (ws, _req) {
    this.decorateClient(ws)
    this.attachMessageHandler(ws)
    this.requestAuthentication(ws)
    this.setInactivityTimeout(ws)
  }

  decorateClient (ws) {
    const challenge = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    ws.nostr = {
      subscriptions: { /* [subId]: { filters, replaceAtMs } */ },
      challenge, /* , pubkey */
      lastActiveAtMs: Date.now() /* , inactivityTimeout */
    }
  }

  attachMessageHandler (ws) { ws.addEventListener('message', this.getHandleMessage()) }

  getHandleMessage () {
    const relay = this

    return function handleMessage (message) {
      const ws = this
      const wsMessage = message.toString()
      let nostrMessage
      try {
        nostrMessage = JSON.parse(wsMessage)
        nostrMessage.byteLength = message.byteLength // buffer
        if (!nostrClientMessages[nostrMessage?.[0]]) nostrMessage = null
      } catch (_err) {
        console.error(`[NOTICE]: Wrong client message (not nostr): ${wsMessage}`)
        nostrMessage = null
      }

      relay.handleNostrMessage({ ws, nostrMessage })
    }
  }

  handleNostrMessage ({ ws, nostrMessage }) {
    const { wss } = this

    new NostrMessageHandler({ wss, ws, nostrMessage }).run()
  }

  requestAuthentication (ws) { requestAuthentication({ ws }) }

  setInactivityTimeout (ws) { disconnectWhenInactive(ws) }
}

export default Relay
