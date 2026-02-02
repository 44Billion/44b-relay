import { eventKinds } from '#constants/event.js'

const appEventKinds = {
  [eventKinds.BINARY_DATA_CHUNK]: true,
  [eventKinds.MAIN_APP_STALL]: true,
  [eventKinds.NEXT_APP_STALL]: true,
  [eventKinds.DRAFT_APP_STALL]: true,
  [eventKinds.MAIN_APP_BUNDLE]: true,
  [eventKinds.NEXT_APP_BUNDLE]: true,
  [eventKinds.DRAFT_APP_BUNDLE]: true
}

export function isAppEvent (event) {
  return Boolean(appEventKinds[event.kind])
}
