import '#config/dotenv.js'

const args = new Set(process.argv.slice(2))
const allowedArgs = new Set(['--reset-stalled', '--clear-errors', '--help'])
const unknownArgs = [...args].filter(arg => !allowedArgs.has(arg))

if (args.has('--help')) {
  console.log(`Usage: npm run job:status -- [options]

Without options this command is strictly read-only.

Options:
  --reset-stalled  Fence and reset jobs whose configured heartbeat expired
  --clear-errors   Clear errors older than three days
  --help           Show this help`)
  process.exit(0)
}
if (unknownArgs.length) {
  console.error(`Unknown option(s): ${unknownArgs.join(', ')}`)
  process.exit(1)
}

const shouldResetStalled = args.has('--reset-stalled')
const shouldClearErrors = args.has('--clear-errors')
// Skip schema migrations and feature writes even when an explicit repair flag
// is present. The requested fenced job patches below are the only mutations.
process.env.MDB_READ_ONLY = 'true'

const [
  { default: mdb },
  { DEFAULT_HEARTBEAT_TOLERANCE }
] = await Promise.all([
  import('#services/db/mdb.js'),
  import('#models/job/trigger.js')
])

const ERROR_CLEAR_AFTER = 3 * 24 * 60 * 60

async function run () {
  const { results: jobs } = await mdb.index('jobs').getDocuments({ limit: 100 })
  const now = Math.floor(Date.now() / 1000)
  const stalledJobs = []
  const staleErrorJobs = []

  console.log('--- Job Status ---')
  for (const job of jobs) {
    const heartbeatTolerance =
      job.heartbeatTolerance ?? DEFAULT_HEARTBEAT_TOLERANCE
    const isRunning = job.endedAt < job.startedAt
    const lastHeartbeat = job.heartbeatedAt || job.startedAt || 0
    const timeSinceHeartbeat = now - lastHeartbeat
    const isStalled = isRunning && timeSinceHeartbeat >= heartbeatTolerance

    console.log(`\nJob: ${job.key}`)
    console.log(`  isRunning: ${isRunning}`)
    if (job.ownerId) console.log(`  owner: ${job.ownerType || 'unknown'}:${job.ownerId}`)
    if (job.ownerPid) console.log(`  ownerPid: ${job.ownerPid}`)
    if (job.continuationRequested) {
      console.log('  continuationRequested: true')
    }
    if (isRunning) {
      console.log(`  timeSinceHeartbeat: ${timeSinceHeartbeat}s`)
      console.log(`  heartbeatTolerance: ${heartbeatTolerance}s`)
      console.log(`  isStalled: ${isStalled}`)
    }
    if (job.lastError) {
      const erroredAtDate = job.erroedAt
        ? new Date(job.erroedAt * 1000).toISOString()
        : 'unknown'
      console.log(`  erroredAt: ${erroredAtDate}`)
      console.log(`  lastError: ${job.lastError.slice(0, 100)}...`)
      if (job.erroedAt && (now - job.erroedAt) >= ERROR_CLEAR_AFTER) {
        staleErrorJobs.push(job)
      }
    }
    if (isStalled) stalledJobs.push(job)
  }

  if (stalledJobs.length) {
    console.log(
      `\nFound ${stalledJobs.length} stalled job(s): ` +
      stalledJobs.map(job => job.key).join(', ')
    )
  } else {
    console.log('\nNo stalled jobs found.')
  }

  if (staleErrorJobs.length) {
    console.log(
      `Found ${staleErrorJobs.length} error(s) older than three days: ` +
      staleErrorJobs.map(job => job.key).join(', ')
    )
  }

  if (!shouldResetStalled && !shouldClearErrors) {
    if (stalledJobs.length) {
      console.log('Use --reset-stalled to fence and reset them explicitly.')
    }
    if (staleErrorJobs.length) {
      console.log('Use --clear-errors to clear those old errors explicitly.')
    }
    return
  }

  const { patchJobByRevision } = await import('#models/job/dao.js')
  async function patchObservedJob (job, patch, action) {
    if (!job.revision) {
      throw new Error(`Cannot ${action} ${job.key}: record has no revision`)
    }
    const result = await patchJobByRevision(job.key, job.revision, patch)
    if (!result.success) {
      throw result.error || new Error(
        `Cannot ${action} ${job.key}: record changed after it was inspected`
      )
    }
    Object.assign(job, result.result.record)
  }

  if (shouldResetStalled) {
    for (const job of stalledJobs) {
      await patchObservedJob(job, {
        startedAt: 0,
        endedAt: 0,
        heartbeatedAt: 0,
        lockKey: null,
        ownerId: null,
        ownerType: null
      }, 'reset')
    }
    console.log(`Reset stalled jobs: ${stalledJobs.map(job => job.key).join(', ') || 'none'}`)
  }

  if (shouldClearErrors) {
    for (const job of staleErrorJobs) {
      await patchObservedJob(job, {
        lastError: null,
        erroedAt: null
      }, 'clear errors for')
    }
    console.log(`Cleared stale errors for: ${staleErrorJobs.map(job => job.key).join(', ') || 'none'}`)
  }
}

try {
  await run()
} catch (error) {
  console.error('Error checking job status:', error)
  process.exitCode = 1
}
