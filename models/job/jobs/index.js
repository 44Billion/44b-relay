// import exampleConfig from './example.js'
import processPendingOpsConfig from './process-pending-ops/index.js'
import calcPopularPubkeysConfig from './calc-popular-pubkeys.js'
import flushRequestedPubkeysConfig from './flush-requested-pubkeys.js'
import deleteExpiredEventsConfig from './delete-expired-events.js'
import flushIpActivityConfig from './flush-ip-activity.js'
import deleteStaleIpsConfig from './delete-stale-ips.js'
import decayRequestedPubkeysConfig from './decay-requested-pubkeys.js'

const jobs = [
  // exampleConfig,
  processPendingOpsConfig,
  calcPopularPubkeysConfig,
  flushRequestedPubkeysConfig,
  deleteExpiredEventsConfig,
  flushIpActivityConfig,
  deleteStaleIpsConfig,
  decayRequestedPubkeysConfig
]

export default jobs
