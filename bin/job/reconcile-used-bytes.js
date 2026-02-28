import '#config/dotenv.js'
import { triggerManualJob } from '#models/job/trigger.js'
import reconcileJob from '#models/job/jobs/reconcile-used-bytes.js'

triggerManualJob(reconcileJob).then(({ started }) => {
  if (!started) console.warn('reconcileUsedBytes lock was taken by another worker.')
  process.exit(0)
}).catch(err => {
  console.error('Reconciliation failed:', err)
  process.exit(1)
})
