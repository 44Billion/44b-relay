import { nostrServerMessages } from '#constants/message.js'

function sendNotice ({ ws, message }) { return ws.send(JSON.stringify([nostrServerMessages.NOTICE, message ?? ''])) }
function sendCommandResult ({ ws, event, isSuccess, message }) { return ws.send(JSON.stringify([nostrServerMessages.OK, event?.id ?? '', isSuccess, message ?? ''])) }
function sendClosed ({ ws, subscriptionId, message }) { return ws.send(JSON.stringify([nostrServerMessages.CLOSED, subscriptionId, message ?? ''])) }
function sendAuth ({ ws, challenge }) { return ws.send(JSON.stringify([nostrServerMessages.AUTH, challenge])) }
function sendCount ({ ws, subscriptionId, count }) { return ws.send(JSON.stringify([nostrServerMessages.COUNT, subscriptionId, { count }])) }
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
