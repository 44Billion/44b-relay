import '#config/dotenv.js'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const execFile = promisify(execFileCallback)
const DEFAULT_PM2_APP = 'web.social-server'
const STARTED_WORKFLOW_FILTER =
  'phase != "queued" AND ' +
  '(type = "upsertManifestWithReservation" OR ' +
  'type = "deleteEventsWithAccounting" OR ' +
  'type = "pruneCheck")'
const STARTED_WORKFLOW_SORT = [
  'startedAt:asc',
  'createdAt:asc',
  'batchId:asc',
  'position:asc',
  'key:asc'
]

export function parseArgs (argv) {
  const options = {
    execute: false,
    pm2App: process.env.PM2_APP || DEFAULT_PM2_APP
  }
  for (const arg of argv) {
    if (arg === '--execute') options.execute = true
    else if (arg === '--help') options.help = true
    else if (arg.startsWith('--pm2-app=')) {
      options.pm2App = arg.slice('--pm2-app='.length)
    } else {
      throw new TypeError(`Unknown option: ${arg}`)
    }
  }
  if (!options.pm2App) throw new TypeError('--pm2-app cannot be empty')
  return options
}

export function assertPm2AppStopped (processes, appName) {
  const matching = processes.filter(processInfo =>
    processInfo.name === appName ||
    processInfo.pm2_env?.name === appName
  )
  if (!matching.length) {
    throw new Error(
      `PM2 app ${appName} was not found; refusing a mutating recovery`
    )
  }
  const active = matching.filter(processInfo =>
    !['stopped', 'errored'].includes(processInfo.pm2_env?.status)
  )
  if (active.length) {
    throw new Error(
      `PM2 app ${appName} still has ${active.length} active instance(s); ` +
      'stop every instance before resuming durable workflows'
    )
  }
  return matching.length
}

async function readPm2Processes (runExecFile = execFile) {
  const { stdout } = await runExecFile('pm2', ['jlist'], {
    maxBuffer: 10 * 1024 * 1024
  })
  let processes
  try {
    processes = JSON.parse(stdout)
  } catch (error) {
    throw new Error('Could not parse `pm2 jlist` output', { cause: error })
  }
  if (!Array.isArray(processes)) {
    throw new Error('`pm2 jlist` did not return an array')
  }
  return processes
}

async function listStartedWorkflows (client, limit = 1000) {
  const { hits } = await client.index('pendingOps').search('', {
    filter: STARTED_WORKFLOW_FILTER,
    limit,
    sort: STARTED_WORKFLOW_SORT,
    attributesToRetrieve: [
      'key',
      'type',
      'phase',
      'startedAt',
      'createdAt',
      'batchId',
      'position',
      'source'
    ]
  })
  return hits
}

export async function run ({
  argv = process.argv.slice(2),
  logger = console,
  dependencies
} = {}) {
  const options = parseArgs(argv)
  if (options.help) {
    logger.log(`Usage: npm run pending-ops:resume-started -- [options]

Dry-run is the default and performs no writes.

Options:
  --execute          Resume only workflows whose phase is no longer "queued"
  --pm2-app=NAME     PM2 app that must be fully stopped
  --help             Show this help`)
    return
  }

  // Dry-run imports the adapter in its explicit read-only mode so schema
  // migration cannot become an accidental write.
  if (!options.execute && !dependencies) process.env.MDB_READ_ONLY = 'true'
  const deps = dependencies || await (async () => {
    const [
      { default: client },
      { processPendingWorkflow },
      { waitForTaskQueueBarrier }
    ] = await Promise.all([
      import('#services/db/mdb.js'),
      import('#services/event/pending-workflows.js'),
      import('#services/db/tasks.js')
    ])
    return {
      client,
      processPendingWorkflow,
      waitForTaskQueueBarrier,
      readPm2Processes
    }
  })()

  const initial = await listStartedWorkflows(deps.client)
  if (!options.execute) {
    logger.log(JSON.stringify({
      mode: 'dry-run',
      pm2App: options.pm2App,
      startedWorkflowCount: initial.length,
      workflows: initial
    }, null, 2))
    if (initial.length) {
      logger.log(
        'Stop every PM2 instance, then repeat with --execute before reconciling usedBytes.'
      )
    }
    return { processed: 0, workflows: initial }
  }

  const processes = await deps.readPm2Processes()
  const pm2Instances = assertPm2AppStopped(processes, options.pm2App)
  await deps.waitForTaskQueueBarrier({ client: deps.client })

  let processed = 0
  while (true) {
    const workflows = await listStartedWorkflows(deps.client, 1)
    if (!workflows.length) break
    const workflow = await deps.client
      .index('pendingOps')
      .getDocument(workflows[0].key)
    await deps.processPendingWorkflow(workflow)
    processed++
  }

  const remaining = await listStartedWorkflows(deps.client)
  logger.log(JSON.stringify({
    mode: 'execute',
    pm2App: options.pm2App,
    pm2Instances,
    processed,
    remainingStartedWorkflows: remaining.length
  }, null, 2))
  return { processed, workflows: remaining }
}

const isEntrypoint = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntrypoint) {
  run().catch(error => {
    console.error('Failed to resume started pending workflows:', error)
    process.exitCode = 1
  })
}
