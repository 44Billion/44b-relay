import '#config/dotenv.js'
import readline from 'node:readline/promises'
import mdb from '#services/db/mdb.js'

const HEARTBEAT_TOLERANCE = 120
const ERROR_CLEAR_AFTER = 3 * 24 * 60 * 60 // 3 days in seconds (matches erroedAt unit)

async function run () {
  try {
    const { results: jobs } = await mdb.index('jobs').getDocuments({ limit: 100 })

    const now = Math.floor(Date.now() / 1000)
    const stalledJobs = []
    const staleErrorJobs = []

    console.log('--- Job Status ---')
    for (const job of jobs) {
      const isRunning = job.endedAt < job.startedAt
      const lastHeartbeat = job.heartbeatedAt || job.startedAt || 0
      const timeSinceHeartbeat = now - lastHeartbeat
      const isStalled = isRunning && timeSinceHeartbeat >= HEARTBEAT_TOLERANCE

      console.log(`\nJob: ${job.key}`)
      console.log(`  isRunning: ${isRunning}`)
      if (isRunning) {
        console.log(`  timeSinceHeartbeat: ${timeSinceHeartbeat}s`)
        console.log(`  isStalled: ${isStalled}`)
      }
      if (job.lastError) {
        const erroredAtDate = job.erroedAt ? new Date(job.erroedAt * 1000).toISOString() : 'unknown'
        console.log(`  erroredAt: ${erroredAtDate}`)
        console.log(`  lastError: ${job.lastError.slice(0, 100)}...`)

        // If the error is old enough, schedule it for clearing
        const isStaleError = job.erroedAt && (now - job.erroedAt) >= ERROR_CLEAR_AFTER
        if (isStaleError) {
          staleErrorJobs.push(job)
        }
      }

      if (isStalled) {
        stalledJobs.push(job)
      }
    }

    if (stalledJobs.length > 0) {
      console.log(`\nFound ${stalledJobs.length} stalled job(s): ${stalledJobs.map(j => j.key).join(', ')}`)

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      })

      const answer = await rl.question('Do you want to reset these stalled jobs? (y/N): ')
      rl.close()

      if (answer.toLowerCase() === 'y') {
        const updates = stalledJobs.map(job => ({
          key: job.key,
          startedAt: 0,
          endedAt: 0,
          heartbeatedAt: 0
        }))

        await mdb.index('jobs').updateDocuments(updates)
        console.log('Stalled jobs have been reset. Workers should pick them up shortly.')
      } else {
        console.log('Skipping reset.')
      }
    } else {
      console.log('\nNo stalled jobs found.')
    }

    // Silently clear lastError/erroedAt for jobs whose error is older than ERROR_CLEAR_AFTER.
    // This keeps the status view clean on future runs without prompting the user.
    if (staleErrorJobs.length > 0) {
      const updates = staleErrorJobs.map(job => ({
        key: job.key,
        lastError: null,
        erroedAt: null
      }))
      try {
        await mdb.index('jobs').updateDocuments(updates)
        console.log(`\nCleared stale lastError for: ${staleErrorJobs.map(j => j.key).join(', ')}`)
      } catch (err) {
        console.error('Failed to clear stale job errors:', err)
      }
    }
  } catch (err) {
    console.error('Error checking job status:', err)
  }
  process.exit(0)
}

run()
