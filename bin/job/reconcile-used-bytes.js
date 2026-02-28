import '#config/dotenv.js'
import reconcileJob from '#models/job/jobs/reconcile-used-bytes.js'

reconcileJob.run().then(() => process.exit(0)).catch(err => {
  console.error('Reconciliation failed:', err)
  process.exit(1)
})
