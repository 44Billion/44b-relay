import { sendAuth } from '#helpers/message.js'
// import { keepTrackOfPubkey } from '#models/event.js'

function isAuthenticated ({ ws }) {
  return !!ws.nostr.pubkey
}
function requestAuthentication ({ ws }) {
  const { nostr: { challenge } } = ws
  return sendAuth({ ws, challenge })
}
async function authenticate ({ ws, event }) {
  const { relay = '', challenge } = (event.tags ?? []).reduce((memo, [k, v]) => {
    memo[k] = v
    return memo
  }, {})
  const isSuccess =
    challenge === ws.nostr.challenge &&
    (Math.abs(event.created_at - Date.now() / 1000) <= 60 * 10) &&
    relay.replace(/\/$/, '') === `${process.env.NODE_ENV === 'production' ? 'wss' : 'ws'}://${process.env.RELAY_HOST}`
  const message = isSuccess ? '' : 'restricted: couldn\'t authenticate'

  if (isSuccess) {
    if (isAuthenticated({ ws }) && ws.nostr.pubkey !== event.pubkey) {
      ws.nostr.subscriptions = {} // reset subs
    }
    ws.nostr.pubkey = event.pubkey
    // await keepTrackOfPubkey({ ws, action: 'authenticate' })
  } else delete ws.nostr.pubkey

  return { isSuccess, message }
}

export {
  isAuthenticated,
  requestAuthentication,
  authenticate
}
