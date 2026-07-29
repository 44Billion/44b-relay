import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  assertSudoAuthorization,
  calculateRequiredFreeBytes,
  checkUpgradeDiskSpace,
  compareDatabaseState,
  detectS3SnapshotOptions,
  dfAvailableArgs,
  downloadRelease,
  executeUpgrade,
  parseArgs,
  RELEASES,
  rollback,
  startSudoKeepalive,
  validateDataPath,
  validateFilePath,
  validateLocalHost,
  validateNonOverlappingPaths,
  validateServiceIdentifier
} from '../../../bin/mdb/upgrade.js'

const tempPaths = []

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(value =>
    rm(value, { recursive: true, force: true })
  ))
})

describe('mdb upgrade guard', () => {
  it('is a dry-run by default and requires both explicit execution flags', () => {
    assert.deepEqual(parseArgs([]), {
      execute: false,
      version: '1.49.0',
      versionWasExplicit: false
    })
    assert.throws(() => parseArgs(['--execute']), /requires --execute --version=1.49.0/)
    assert.equal(
      parseArgs(['--execute', '--version=1.49.0']).execute,
      true
    )
  })

  it('rejects remote hosts and broad data paths', () => {
    assert.equal(validateLocalHost('http://localhost:7700'), 'http://localhost:7700')
    assert.throws(() => validateLocalHost('https://example.com'), /non-local/)
    assert.throws(() => validateLocalHost('http://user@localhost:7700'), /non-local/)
    assert.throws(() => validateDataPath('/'), /unsafe/)
    assert.throws(() => validateDataPath('/var/lib'), /unsafe/)
    assert.throws(() => validateDataPath('relative/data/path'), /absolute/)
    assert.throws(() => validateFilePath('relative-binary', 'binary path'), /absolute/)
  })

  it('rejects option-like service names and overlapping backup paths', () => {
    assert.equal(
      validateServiceIdentifier('web.social-server', 'PM2 application name'),
      'web.social-server'
    )
    assert.throws(
      () => validateServiceIdentifier('--all', 'PM2 application name'),
      /Invalid/
    )
    assert.throws(
      () => validateNonOverlappingPaths([
        ['snapshot path', '/var/lib/meilisearch'],
        ['backup root', '/var/lib/meilisearch/backups']
      ]),
      /cannot overlap/
    )
  })

  it('requests available disk space without incompatible df options', () => {
    const args = dfAvailableArgs('/var/lib/meilisearch')
    assert.deepEqual(args, [
      '-k',
      '--output=avail',
      '/var/lib/meilisearch'
    ])
    assert.equal(args.includes('-P'), false)
    assert.equal(args.some(arg => arg.includes('P')), false)
  })

  it('detects S3 snapshot configuration without exposing its values', () => {
    assert.deepEqual(detectS3SnapshotOptions({
      configText: `
        snapshot_dir = "/var/lib/meilisearch/snapshots"
        s3_bucket_name = "private-bucket"
        experimental_s3_role_arn = "private-role"
      `,
      serviceEnvironment:
        'MEILI_S3_BUCKET_REGION=us-east-1 MEILI_LOG_LEVEL=INFO',
      execStart:
        '/usr/local/bin/meilisearch --s3-snapshot-prefix=production/'
    }), [
      'command:--s3-snapshot-prefix',
      'config:experimental_s3_role_arn',
      'config:s3_bucket_name',
      'environment:MEILI_S3_BUCKET_REGION'
    ])
  })

  it('rechecks actual snapshot size before allowing the destructive phase', async () => {
    assert.equal(calculateRequiredFreeBytes({
      dataBytes: 1000,
      snapshotBytes: 200
    }), 2_000 + 200 + 1024 ** 3)

    await assert.rejects(
      checkUpgradeDiskSpace({
        dataPath: '/var/lib/meilisearch/data',
        snapshotPath: '/var/lib/meilisearch/snapshots',
        backupRoot: '/var/lib/meilisearch/upgrade-backups',
        backupParent: '/var/lib/meilisearch'
      }, {
        phase: 'post-snapshot',
        runSudoFn: async args => {
          if (args[0] === 'du' && args.at(-1).endsWith('/data')) {
            return { stdout: '1000\t/var/lib/meilisearch/data\n' }
          }
          if (args[0] === 'du') {
            return { stdout: '200\t/var/lib/meilisearch/snapshots\n' }
          }
          return { stdout: 'Avail\n1\n' }
        }
      }),
      /Insufficient disk space during post-snapshot/
    )
  })

  it('turns missing cached sudo authorization into actionable guidance', async () => {
    await assert.rejects(
      assertSudoAuthorization({
        runCommandFn: async () => {
          const error = new Error('sudo: a password is required')
          error.code = 1
          throw error
        }
      }),
      error => error.code === 'SUDO_AUTH_REQUIRED' &&
        error.message.includes('sudo -v') &&
        error.message.includes('Do not run npm itself with sudo')
    )
  })

  it('renews sudo authorization until the upgrade finishes', async () => {
    const callbacks = []
    const clearedTimers = []
    let timerId = 0
    const renew = mock.fn()
    const stop = startSudoKeepalive({
      intervalMs: 123,
      renew,
      logger: silentLogger,
      setTimer: (callback, interval) => {
        assert.equal(interval, 123)
        callbacks.push(callback)
        return ++timerId
      },
      clearTimer: timer => clearedTimers.push(timer)
    })

    await callbacks.shift()()
    assert.equal(renew.mock.callCount(), 1)
    assert.equal(callbacks.length, 1)
    await stop()
    assert.deepEqual(clearedTimers, [2])
  })

  it('rejects a downloaded binary whose SHA-256 differs', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mdb-upgrade-test-'))
    tempPaths.push(directory)
    await assert.rejects(
      downloadRelease(
        RELEASES['1.49.0'].x64,
        '1.49.0',
        path.join(directory, 'meilisearch'),
        { fetchFn: async () => new Response('not the release binary') }
      ),
      /Checksum mismatch/
    )
  })

  it('detects post-upgrade count changes', () => {
    const errors = compareDatabaseState({
      targetVersion: '1.49.0',
      stats: { indexes: { events: { numberOfDocuments: 2 } } }
    }, {
      version: { pkgVersion: '1.49.0' },
      health: { status: 'available' },
      stats: { indexes: { events: { numberOfDocuments: 1 } } }
    })
    assert.match(errors.join(' '), /document counts changed/)
  })

  it('runs the guarded phases in order and does not roll back success', async () => {
    const calls = []
    const rollbackMock = mock.fn()
    const context = makeContext()
    const result = await executeUpgrade(context, {
      logger: silentLogger,
      operations: fakeOperations(calls, { rollback: rollbackMock })
    })

    assert.deepEqual(calls, [
      'download',
      'binary-version',
      'pm2-stop',
      'drain',
      'baseline',
      'snapshot',
      'snapshot-wait',
      'disk-recheck',
      'mdb-stop',
      'backup-mkdir',
      'backup-old-binary',
      'backup-config',
      'backup-new-binary',
      'backup-snapshot',
      'backup-data',
      'install',
      'dumpless',
      'mdb-start',
      'health',
      'pm2-restart',
      'remove-temp'
    ])
    assert.equal(rollbackMock.mock.callCount(), 0)
    assert.equal(result.finalState.version.pkgVersion, '1.49.0')
  })

  it('invokes rollback with a completed cold backup after a later phase fails', async () => {
    const calls = []
    const rollbackMock = mock.fn(async (_context, state) => {
      assert.equal(state.backupReady, true)
      assert.equal(state.pm2Stopped, true)
      calls.push('rollback')
    })
    await assert.rejects(
      executeUpgrade(makeContext(), {
        logger: silentLogger,
        operations: fakeOperations(calls, {
          rollback: rollbackMock,
          runDumplessUpgrade: async () => {
            calls.push('dumpless')
            throw new Error('upgrade task failed')
          }
        })
      }),
      /upgrade task failed/
    )
    assert.deepEqual(calls.slice(-2), ['rollback', 'remove-temp'])
  })

  it('invokes rollback when any guarded execution phase fails', async () => {
    const phases = [
      'download',
      'binary-version',
      'pm2-stop',
      'drain',
      'baseline',
      'snapshot',
      'snapshot-wait',
      'disk-recheck',
      'mdb-stop',
      'backup-mkdir',
      'backup-old-binary',
      'backup-config',
      'backup-new-binary',
      'backup-snapshot',
      'backup-data',
      'install',
      'dumpless',
      'mdb-start',
      'health',
      'pm2-restart'
    ]

    for (const phase of phases) {
      const calls = []
      const rollbackMock = mock.fn(async () => calls.push('rollback'))
      await assert.rejects(
        executeUpgrade(makeContext(), {
          logger: silentLogger,
          operations: fakeOperations(calls, {
            failAt: phase,
            rollback: rollbackMock
          })
        }),
        new RegExp(`failed at ${phase}`)
      )
      assert.equal(rollbackMock.mock.callCount(), 1, phase)
      assert.deepEqual(calls.slice(-2), ['rollback', 'remove-temp'], phase)
    }
  })

  it('moves failed data aside and restores the intact cold copy', async () => {
    const sudoCalls = []
    const commandCalls = []
    await rollback(makeContext(), {
      transientUnit: 'upgrade-unit',
      mdbStopped: true,
      normalMdbStarted: false,
      backupReady: true,
      backupDir: '/var/lib/meilisearch/upgrade-backups/run',
      pm2Stopped: true
    }, silentLogger, {
      runSudo: async args => {
        sudoCalls.push(args)
        return { stdout: '' }
      },
      runCommand: async (file, args) => {
        commandCalls.push([file, args])
        return { stdout: '' }
      },
      waitForHealth: async () => makeFinalState()
    })

    assert.ok(sudoCalls.some(args => args[0] === 'mv' &&
      args.at(-1).endsWith('/data.failed')))
    assert.ok(sudoCalls.some(args => args[0] === 'cp' &&
      args.includes('/var/lib/meilisearch/upgrade-backups/run/data.cold')))
    assert.deepEqual(commandCalls.at(-1), [
      'pm2',
      ['restart', 'web.social-server']
    ])
  })
})

const silentLogger = { log () {}, warn () {}, error () {} }

function makeFinalState () {
  return {
    version: { pkgVersion: '1.49.0' },
    health: { status: 'available' },
    stats: { indexes: { events: { numberOfDocuments: 2 } } }
  }
}

function makeContext () {
  let stateCalls = 0
  return {
    version: '1.49.0',
    currentVersion: '1.35.1',
    release: RELEASES['1.49.0'].x64,
    serviceName: 'meilisearch',
    pm2App: 'web.social-server',
    binaryPath: '/usr/local/bin/meilisearch',
    configPath: '/etc/meilisearch.toml',
    dataPath: '/var/lib/meilisearch/data',
    snapshotPath: '/var/lib/meilisearch/snapshots',
    backupRoot: '/var/lib/meilisearch/upgrade-backups',
    binaryOwner: 0,
    binaryGroup: 0,
    binaryMode: '755',
    api: {
      async state () {
        stateCalls++
        assert.equal(stateCalls, 1)
        return {
          version: { pkgVersion: '1.35.1' },
          health: { status: 'available' },
          stats: { indexes: { events: { numberOfDocuments: 2 } } }
        }
      },
      async createSnapshot () {
        return { taskUid: 7 }
      }
    }
  }
}

function fakeOperations (calls, overrides = {}) {
  const { failAt, ...operationOverrides } = overrides
  const finalState = makeFinalState()
  const recordCall = phase => {
    calls.push(phase)
    if (phase === failAt) throw new Error(`failed at ${phase}`)
  }
  return {
    mkdtemp: async () => '/tmp/fake-upgrade',
    downloadRelease: async () => recordCall('download'),
    runCommand: async (file, args) => {
      if (args[0] === '--version') {
        recordCall('binary-version')
        return { stdout: 'meilisearch 1.49.0' }
      }
      recordCall(args[0] === 'stop' ? 'pm2-stop' : 'pm2-restart')
      return { stdout: '' }
    },
    runSudo: async args => {
      const key = sudoCallName(args)
      recordCall(key)
      return { stdout: '' }
    },
    drainQueue: async context => {
      recordCall('drain')
      const original = context.api.state
      const originalSnapshot = context.api.createSnapshot
      context.api.state = async () => {
        recordCall('baseline')
        return original()
      }
      context.api.createSnapshot = async () => {
        recordCall('snapshot')
        return originalSnapshot()
      }
    },
    waitForTask: async () => recordCall('snapshot-wait'),
    checkUpgradeDiskSpace: async () => recordCall('disk-recheck'),
    runDumplessUpgrade: async () => recordCall('dumpless'),
    waitForHealth: async () => {
      recordCall('health')
      return finalState
    },
    removeTemporaryDownload: async () => recordCall('remove-temp'),
    rollback: mock.fn(),
    ...operationOverrides
  }
}

function sudoCallName (args) {
  if (args[0] === 'systemctl') {
    return args[1] === 'stop' ? 'mdb-stop' : 'mdb-start'
  }
  if (args[0] === 'mkdir') return 'backup-mkdir'
  if (args[0] === 'install') return 'install'
  const source = args.at(-2)
  if (source === '/usr/local/bin/meilisearch') return 'backup-old-binary'
  if (source === '/etc/meilisearch.toml') return 'backup-config'
  if (source?.endsWith('meilisearch-linux-amd64')) return 'backup-new-binary'
  if (source === '/var/lib/meilisearch/snapshots') return 'backup-snapshot'
  if (source === '/var/lib/meilisearch/data') return 'backup-data'
  return args.join(' ')
}
