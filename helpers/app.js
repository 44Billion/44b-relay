import { eventKinds } from '#constants/event.js'

const appEventKinds = {
  [eventKinds.BINARY_DATA_CHUNK]: true,
  [eventKinds.MAIN_APP_LISTING]: true,
  [eventKinds.NEXT_APP_LISTING]: true,
  [eventKinds.DRAFT_APP_LISTING]: true,
  [eventKinds.MAIN_SITE_MANIFEST]: true,
  [eventKinds.NEXT_SITE_MANIFEST]: true,
  [eventKinds.DRAFT_SITE_MANIFEST]: true
}

export function isAppEvent (event) {
  return Boolean(appEventKinds[event.kind])
}
