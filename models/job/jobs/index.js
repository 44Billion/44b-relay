// import exampleConfig from './example.js'
import processPendingOpsConfig from './process-pending-ops.js'
import calcPopularPubkeysConfig from './calc-popular-pubkeys.js'
import flushRequestedPubkeysConfig from './flush-requested-pubkeys.js'
import deleteExpiredEventsConfig from './delete-expired-events.js'
import flushIpActivityConfig from './flush-ip-activity.js'
import deleteStaleIpsConfig from './delete-stale-ips.js'

const jobs = [
  // exampleConfig,
  processPendingOpsConfig,
  calcPopularPubkeysConfig,
  flushRequestedPubkeysConfig,
  deleteExpiredEventsConfig,
  flushIpActivityConfig,
  deleteStaleIpsConfig
]

export default jobs
