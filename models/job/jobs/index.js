// import exampleConfig from './example.js'
import processPendingOpsConfig from './process-pending-ops/index.js'
import calcPopularPubkeysConfig from './calc-popular-pubkeys.js'
import flushRequestedPubkeysConfig from './flush-requested-pubkeys.js'
import deleteExpiredEventsConfig from './delete-expired-events.js'
import flushIpActivityConfig from './flush-ip-activity.js'
import deleteStaleIpsConfig from './delete-stale-ips.js'
import decayRequestedPubkeysConfig from './decay-requested-pubkeys.js'
import decayTrendingEventsConfig from './decay-trending-events.js'
import decayOldTrendingEventsConfig from './decay-old-trending-events.js'
import trackUptimeConfig from './track-uptime.js'
import flushHashtagStatsConfig from './flush-hashtag-stats.js'
import decayHashtagStatsConfig from './decay-hashtag-stats.js'
import generateLocalizedTopicAssertionEventsConfig from './generate-localized-topic-assertion-events.js'

const jobs = [
  // exampleConfig,
  processPendingOpsConfig,
  calcPopularPubkeysConfig,
  flushRequestedPubkeysConfig,
  deleteExpiredEventsConfig,
  flushIpActivityConfig,
  deleteStaleIpsConfig,
  decayRequestedPubkeysConfig,
  decayTrendingEventsConfig,
  decayOldTrendingEventsConfig,
  trackUptimeConfig,
  flushHashtagStatsConfig,
  decayHashtagStatsConfig,
  generateLocalizedTopicAssertionEventsConfig
]

export default jobs
