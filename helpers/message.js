import { nostrServerMessages } from '#constants/message.js'

function sendNotice ({ ws, message }) { return ws.send(JSON.stringify([nostrServerMessages.NOTICE, message ?? ''])) }
function sendCommandResult ({ ws, event, isSuccess, message, extra }) {
  const msg = [nostrServerMessages.OK, event?.id ?? '', isSuccess, message ?? '']
  if (extra) msg.push(extra)
  return ws.send(JSON.stringify(msg))
}
function sendClosed ({ ws, subscriptionId, message, extra }) {
  const msg = [nostrServerMessages.CLOSED, subscriptionId, message ?? '']
  if (extra) msg.push(extra)
  return ws.send(JSON.stringify(msg))
}
function sendAuth ({ ws, challenge }) { return ws.send(JSON.stringify([nostrServerMessages.AUTH, challenge])) }
function sendCount ({ ws, subscriptionId, count, approximate, hll }) {
  return ws.send(JSON.stringify([
    nostrServerMessages.COUNT,
    subscriptionId,
    {
      count,
      ...(approximate !== undefined && { approximate }),
      ...(hll !== undefined && { hll })
    }
  ]))
}
function sendEvent ({ ws, subscriptionId, event }) { return ws.send(JSON.stringify([nostrServerMessages.EVENT, subscriptionId, event])) }
function sendEose ({ ws, subscriptionId }) { return ws.send(JSON.stringify([nostrServerMessages.EOSE, subscriptionId])) }

export {
  sendNotice,
  sendCommandResult,
  sendClosed,
  sendAuth,
  sendCount,
  sendEvent,
  sendEose
}
