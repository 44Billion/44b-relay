import { isValidEvent } from '#helpers/event.js'
import { sendCommandResult } from '#helpers/message.js'
import { nostrClientMessages } from '#constants/message.js'
import { authenticate } from '#services/relay/authenticator.js'
import { rateLimitReqByPubkey } from '#services/rate-limiting/web-socket-request-limiter.js'

class AuthHandler {
  static run ({ wss, ws, nostrMessage }) {
    return new this({ wss, ws, nostrMessage }).run()
  }

  constructor ({ wss, ws, nostrMessage }) {
    Object.assign(this, { wss, ws, nostrMessage })
  }

  async run () {
    const { ws, nostrMessage } = this
    const [, event = {}] = nostrMessage
    let { isSuccess, message } = await isValidEvent({ event, clientMessage: nostrClientMessages.AUTH })
    if (!isSuccess) return sendCommandResult({ ws, event, isSuccess, message })

    ;({ isSuccess, message } = await authenticate({ ws, event }))
    if (isSuccess) {
      const { isBlocked } = this.applyCustomRelayRestrictionsToRequest(ws)
      if (isBlocked) return
    }
    return sendCommandResult({ ws, event, isSuccess, message })
  }

  applyCustomRelayRestrictionsToRequest (ws) {
    const { isRateLimited } = rateLimitReqByPubkey(ws)
    if (isRateLimited) ws.close(1013, 'Try again later. Rate limited')

    return { isBlocked: isRateLimited }
  }
}

export default AuthHandler
