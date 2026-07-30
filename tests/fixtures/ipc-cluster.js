import cluster from 'node:cluster'
import fs from 'node:fs'
import { createBroadcaster } from '../../services/ipc/cross-process-broadcaster.js'
import { init as initJobWorker } from '../../models/job/worker.js'

const socketPath = process.argv[2]
const protectedJobKey = process.argv[3]

if (cluster.isPrimary) {
  const states = new Map()
  const ready = new Set()
  const jobStarts = []
  let initialLeader
  let initialReported = false
  let failoverReported = false
  let reportTimer = null

  function leaders () {
    return [...states].filter(([, isLeader]) => isLeader).map(([pid]) => pid)
  }

  function reportStableState () {
    reportTimer = null
    const current = leaders()
    const jobPids = [...new Set(jobStarts)]
    if (!initialReported &&
        ready.size === 2 &&
        current.length === 1 &&
        jobPids.length === 1 &&
        jobPids[0] === current[0]) {
      initialReported = true
      initialLeader = current[0]
      process.stdout.write(JSON.stringify({
        phase: 'initial',
        leaders: current,
        workers: [...ready],
        protectedJobPids: jobPids
      }) + '\n')
      return
    }
    if (initialReported &&
        !failoverReported &&
        current.length === 1 &&
        current[0] !== initialLeader &&
        jobPids.length === 2 &&
        jobPids.includes(current[0])) {
      failoverReported = true
      process.stdout.write(JSON.stringify({
        phase: 'failover',
        leaders: current,
        protectedJobPids: jobPids
      }) + '\n')
    }
  }

  function maybeReport () {
    clearTimeout(reportTimer)
    reportTimer = setTimeout(reportStableState, 100)
  }

  for (let index = 0; index < 2; index++) {
    const worker = cluster.fork()
    worker.on('message', message => {
      if (message?.type === 'ready') ready.add(message.pid)
      if (message?.type === 'protected-job-start') {
        jobStarts.push(message.pid)
      }
      if (message?.type === 'leadership') {
        states.set(message.pid, message.value)
      }
      maybeReport()
    })
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', data => {
    if (!data.includes('failover') || !initialLeader) return
    const leader = Object.values(cluster.workers)
      .find(worker => worker.process.pid === initialLeader)
    leader?.send({ type: 'close-leader' })
  })

  function shutdown () {
    clearTimeout(reportTimer)
    for (const worker of Object.values(cluster.workers)) worker?.kill()
    try { fs.unlinkSync(socketPath) } catch {}
    try { fs.unlinkSync(`${socketPath}.lock`) } catch {}
    setTimeout(() => process.exit(0), 10).unref()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
} else {
  const broadcaster = createBroadcaster({
    socketPath,
    lockPath: `${socketPath}.lock`,
    connectRetryMs: 20,
    staleProbeTimeoutMs: 30,
    lockStaleMs: 100,
    broadcastTimeoutMs: 500,
    addCleanup: () => {},
    logger: { log () {}, warn () {}, error () {} }
  })
  broadcaster.subscribeLeadership(value => {
    process.send?.({
      type: 'leadership',
      pid: process.pid,
      value
    })
  })
  broadcaster.init(() => {})
  await broadcaster.waitUntilReady({ timeoutMs: 3000 })

  await initJobWorker([{
    key: protectedJobKey,
    frequency: 60 * 60,
    initialDelay: 0,
    shouldUseLock: true,
    async run ({ signal }) {
      process.send?.({
        type: 'protected-job-start',
        pid: process.pid
      })
      await new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason)
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    }
  }], {
    leadership: {
      subscribe: handler => broadcaster.subscribeLeadership(handler)
    },
    waitForTaskQueueBarrier: async () => {}
  })

  process.send?.({ type: 'ready', pid: process.pid })

  process.on('message', async message => {
    if (message?.type !== 'close-leader') return
    await broadcaster.close()
  })
}
