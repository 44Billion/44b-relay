import '#config/dotenv.js'
import { triggerManualJob } from '#models/job/trigger.js'
import migrationJob from '#models/job/jobs/migrate-irfs-v2.js'

triggerManualJob(migrationJob).then(({ started }) => {
  if (!started) console.warn('migrateIrfsV2 lock was taken by another worker.')
  process.exit(0)
}).catch(error => {
  console.error('IRFS/MMR v2 migration failed:', error)
  process.exit(1)
})
