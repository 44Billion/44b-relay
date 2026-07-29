import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  assertSudoAuthorization,
  calculateDumpCreationRequiredFreeBytes,
  calculateDumpImportRequiredFreeBytes,
  calculateRequiredFreeBytes,
  checkDumpCreationDiskSpace,
  checkDumpImportDiskSpace,
  checkUpgradeDiskSpace,
  compareDatabaseState,
  detectS3SnapshotOptions,
  dfAvailableArgs,
  downloadRelease,
  dumpFileForTask,
  executeUpgrade,
  parseArgs,
  prepareTargetConfig,
  RELEASES,
  resolveConfiguredDumpPath,
  resolveServiceTmpPath,
  rollback,
  startSudoKeepalive,
  sumTarEntryBytes,
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
      strategy: 'dump',
      version: '1.51.0',
      versionWasExplicit: false
    })
    assert.throws(() => parseArgs(['--execute']), /requires --execute --version=1.51.0/)
    assert.equal(
      parseArgs(['--execute', '--version=1.51.0']).execute,
      true
    )
    assert.equal(parseArgs(['--dumpless']).strategy, 'dumpless')
    assert.equal(
      parseArgs(['--execute', '--version=1.51.0', '--dumpless']).strategy,
      'dumpless'
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

  it('removes the obsolete dumpless option from the target configuration', () => {
    const config = [
      '# This comment must remain.',
      'experimental_dumpless_upgrade = true',
      '# experimental_dumpless_upgrade = false',
      'db_path = "/var/lib/meilisearch/data"',
      ''
    ].join('\n')
    const prepared = prepareTargetConfig(config, '1.51.0')

    assert.deepEqual(prepared.removedOptions, [
      'experimental_dumpless_upgrade'
    ])
    assert.deepEqual(prepared.reviewRequiredOptions, [])
    assert.equal(
      prepared.text,
      [
        '# This comment must remain.',
        '# experimental_dumpless_upgrade = false',
        'db_path = "/var/lib/meilisearch/data"',
        ''
      ].join('\n')
    )
    assert.deepEqual(prepareTargetConfig(config, '1.50.0'), {
      text: config,
      removedOptions: [],
      reviewRequiredOptions: []
    })

    const reviewRequired = prepareTargetConfig(
      `${config}experimental_replication_parameters = true\n`,
      '1.51.0'
    )
    assert.deepEqual(reviewRequired.reviewRequiredOptions, [
      'experimental_replication_parameters'
    ])
    assert.match(
      reviewRequired.text,
      /experimental_replication_parameters = true/
    )
    assert.deepEqual(reviewRequired.removedOptions, [
      'experimental_dumpless_upgrade'
    ])
    assert.equal(
      reviewRequired.text.includes('experimental_dumpless_upgrade = true'),
      false
    )
  })

  it('resolves the effective dump and staging paths used by the service', () => {
    assert.deepEqual(resolveConfiguredDumpPath({
      configText: 'dump_dir = "configured-dumps"',
      serviceEnvironment: 'MEILI_DUMP_DIR=environment-dumps',
      execStart: '/usr/local/bin/meilisearch --dump-dir command-dumps',
      workingDirectory: '/var/lib/meilisearch'
    }), {
      path: '/var/lib/meilisearch/command-dumps',
      source: 'command:--dump-dir'
    })
    assert.deepEqual(resolveConfiguredDumpPath({
      configText: 'dump_dir = "configured-dumps"',
      workingDirectory: '/var/lib/meilisearch'
    }), {
      path: '/var/lib/meilisearch/configured-dumps',
      source: 'config:dump_dir'
    })
    assert.equal(
      resolveServiceTmpPath({
        serviceEnvironment: 'TMPDIR=/var/lib/meilisearch/tmp',
        workingDirectory: '/ignored'
      }),
      '/var/lib/meilisearch/tmp'
    )
    assert.equal(
      resolveServiceTmpPath({
        serviceEnvironment: 'TMPDIR=tmp',
        workingDirectory: '/var/lib/meilisearch'
      }),
      '/var/lib/meilisearch/tmp'
    )
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

  it('measures dump staging and import space before replacing data', async () => {
    assert.equal(calculateDumpCreationRequiredFreeBytes({
      dataBytes: 1000
    }), 2_000 + 1024 ** 3)
    assert.equal(calculateDumpImportRequiredFreeBytes({
      dataBytes: 1000,
      uncompressedDumpBytes: 500
    }), 1250 + 550 + 1024 ** 3)
    assert.equal(sumTarEntryBytes(`
-rw-r--r-- 0/0 200 2026-07-29 00:00 indexes/events/documents.jsonl
-rw-r--r-- 0/0 300 2026-07-29 00:00 tasks/queue.jsonl
    `), 500)

    await assert.rejects(
      checkDumpCreationDiskSpace({
        dataPath: '/var/lib/meilisearch/data',
        backupRoot: '/var/lib/meilisearch/upgrade-backups',
        backupParent: '/var/lib/meilisearch'
      }, {
        runSudoFn: async args => args[0] === 'du'
          ? { stdout: '1000\t/var/lib/meilisearch/data\n' }
          : { stdout: 'Avail\n1\n' }
      }),
      /Insufficient disk space/
    )

    const result = await checkDumpImportDiskSpace({
      dataPath: '/var/lib/meilisearch/data',
      backupRoot: '/var/lib/meilisearch/upgrade-backups',
      backupParent: '/var/lib/meilisearch'
    }, '/var/lib/meilisearch/dumps/source.dump', {
      runSudoFn: async args => {
        if (args[0] === 'du') {
          return { stdout: '1000\t/var/lib/meilisearch/data\n' }
        }
        if (args[0] === 'stat') return { stdout: '100\n' }
        if (args[0] === 'tar') {
          return {
            stdout:
              '-rw-r--r-- 0/0 200 2026-07-29 00:00 documents.jsonl\n' +
              '-rw-r--r-- 0/0 300 2026-07-29 00:00 tasks.jsonl\n'
          }
        }
        if (args[0] === 'df') return { stdout: 'Avail\n3000000\n' }
        return { stdout: '' }
      }
    })
    assert.equal(result.dumpBytes, 100)
    assert.equal(result.uncompressedDumpBytes, 500)
  })

  it('accepts only safe dump UIDs returned by Meilisearch', () => {
    const context = { dumpPath: '/var/lib/meilisearch/dumps' }
    assert.equal(
      dumpFileForTask(context, {
        details: { dumpUid: '20260729-123456789' }
      }),
      '/var/lib/meilisearch/dumps/20260729-123456789.dump'
    )
    assert.throws(
      () => dumpFileForTask(context, {
        details: { dumpUid: '../../etc/passwd' }
      }),
      /safe dump UID/
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
        RELEASES['1.51.0'].x64,
        '1.51.0',
        path.join(directory, 'meilisearch'),
        { fetchFn: async () => new Response('not the release binary') }
      ),
      /Checksum mismatch/
    )
  })

  it('detects post-upgrade count changes', () => {
    const errors = compareDatabaseState({
      targetVersion: '1.51.0',
      stats: { indexes: { events: { numberOfDocuments: 2 } } }
    }, {
      version: { pkgVersion: '1.51.0' },
      health: { status: 'available' },
      stats: { indexes: { events: { numberOfDocuments: 1 } } }
    })
    assert.match(errors.join(' '), /document counts changed/)
  })

  it('uses the guarded dump phases by default without copying old data', async () => {
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
      'dump',
      'dump-wait',
      'dump-space',
      'backup-mkdir',
      'backup-owner',
      'backup-mode',
      'backup-old-binary',
      'backup-config',
      'backup-new-binary',
      'mdb-stop',
      'move-dump',
      'move-data',
      'install',
      'dump-import',
      'mdb-start',
      'health',
      'pm2-restart',
      'remove-temp'
    ])
    assert.equal(rollbackMock.mock.callCount(), 0)
    assert.equal(result.strategy, 'dump')
    assert.equal(result.finalState.version.pkgVersion, '1.51.0')
  })

  it('keeps the snapshot and cold-copy strategy behind --dumpless', async () => {
    const calls = []
    const rollbackMock = mock.fn()
    const result = await executeUpgrade(makeContext('dumpless'), {
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
      'backup-mkdir',
      'backup-owner',
      'backup-mode',
      'backup-old-binary',
      'backup-config',
      'backup-new-binary',
      'mdb-stop',
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
    assert.equal(result.strategy, 'dumpless')
  })

  it('installs a compatible target config and keeps rollback protection', async () => {
    const calls = []
    const rollbackMock = mock.fn()
    const context = {
      ...makeContext(),
      targetConfigText: 'db_path = "/var/lib/meilisearch/data"\n',
      configChanges: [
        'remove obsolete experimental_dumpless_upgrade'
      ],
      configOwner: '0',
      configGroup: '123',
      configMode: '640'
    }
    await executeUpgrade(context, {
      logger: silentLogger,
      operations: fakeOperations(calls, { rollback: rollbackMock })
    })

    assert.ok(
      calls.indexOf('prepare-config') < calls.indexOf('pm2-stop')
    )
    assert.ok(
      calls.indexOf('backup-config') < calls.indexOf('install-config')
    )
    assert.ok(
      calls.indexOf('install-config') < calls.indexOf('move-data')
    )
    assert.equal(rollbackMock.mock.callCount(), 0)
  })

  it('invokes rollback with the moved source database after import fails', async () => {
    const calls = []
    const rollbackMock = mock.fn(async (_context, state) => {
      assert.equal(state.strategy, 'dump')
      assert.equal(state.backupReady, true)
      assert.equal(state.dataMoveStarted, true)
      assert.equal(state.pm2Stopped, true)
      calls.push('rollback')
    })
    await assert.rejects(
      executeUpgrade(makeContext(), {
        logger: silentLogger,
        operations: fakeOperations(calls, {
          rollback: rollbackMock,
          runDumpImport: async () => {
            calls.push('dump-import')
            throw new Error('dump import failed')
          }
        })
      }),
      /dump import failed/
    )
    assert.deepEqual(calls.slice(-2), ['rollback', 'remove-temp'])
  })

  it('invokes rollback when any guarded strategy phase fails', async () => {
    const strategyPhases = {
      dump: [
        'download',
        'binary-version',
        'pm2-stop',
        'drain',
        'baseline',
        'dump',
        'dump-wait',
        'dump-space',
        'backup-mkdir',
        'backup-owner',
        'backup-mode',
        'backup-old-binary',
        'backup-config',
        'backup-new-binary',
        'mdb-stop',
        'move-dump',
        'move-data',
        'install',
        'dump-import',
        'mdb-start',
        'health',
        'pm2-restart'
      ],
      dumpless: [
        'snapshot',
        'snapshot-wait',
        'disk-recheck',
        'backup-snapshot',
        'backup-data',
        'dumpless'
      ]
    }

    for (const [strategy, phases] of Object.entries(strategyPhases)) {
      for (const phase of phases) {
        const calls = []
        const rollbackMock = mock.fn(async () => calls.push('rollback'))
        await assert.rejects(
          executeUpgrade(makeContext(strategy), {
            logger: silentLogger,
            operations: fakeOperations(calls, {
              failAt: phase,
              rollback: rollbackMock
            })
          }),
          new RegExp(`failed at ${phase}`)
        )
        assert.equal(rollbackMock.mock.callCount(), 1, `${strategy}:${phase}`)
        assert.deepEqual(
          calls.slice(-2),
          ['rollback', 'remove-temp'],
          `${strategy}:${phase}`
        )
      }
    }
  })

  it('restores the moved source database and removes generated failed data', async () => {
    const sudoCalls = []
    const commandCalls = []
    await rollback(makeContext(), {
      strategy: 'dump',
      transientUnit: 'upgrade-unit',
      mdbStopped: true,
      normalMdbStarted: false,
      backupReady: true,
      dataMoveStarted: true,
      binaryInstallStarted: true,
      backupDir: '/var/lib/meilisearch/upgrade-backups/run',
      oldDataPath: '/var/lib/meilisearch/upgrade-backups/run/data.old',
      importTempPath: '/var/lib/meilisearch/upgrade-backups/run/import-tmp',
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
    assert.ok(sudoCalls.some(args => args[0] === 'mv' &&
      args[1].endsWith('/data.old') &&
      args.at(-1) === '/var/lib/meilisearch/data'))
    assert.ok(sudoCalls.some(args => args[0] === 'rm' &&
      args.at(-1).endsWith('/data.failed')))
    assert.deepEqual(commandCalls.at(-1), [
      'pm2',
      ['restart', 'web.social-server']
    ])
  })

  it('restores the intact cold copy for a failed dumpless upgrade', async () => {
    const sudoCalls = []
    await rollback(makeContext('dumpless'), {
      strategy: 'dumpless',
      transientUnit: 'upgrade-unit',
      mdbStopped: true,
      normalMdbStarted: false,
      backupReady: true,
      dataMoveStarted: false,
      binaryInstallStarted: true,
      backupDir: '/var/lib/meilisearch/upgrade-backups/run',
      pm2Stopped: false
    }, silentLogger, {
      runSudo: async args => {
        sudoCalls.push(args)
        return { stdout: '' }
      },
      waitForHealth: async () => makeFinalState()
    })

    assert.ok(sudoCalls.some(args => args[0] === 'cp' &&
      args.includes('/var/lib/meilisearch/upgrade-backups/run/data.cold')))
  })

  it('restores the old config when target config installation fails first', async () => {
    const sudoCalls = []
    await rollback(makeContext(), {
      strategy: 'dump',
      transientUnit: null,
      mdbStopped: true,
      normalMdbStarted: false,
      backupReady: false,
      dataMoveStarted: false,
      configInstallStarted: true,
      binaryInstallStarted: false,
      backupDir: '/var/lib/meilisearch/upgrade-backups/run',
      pm2Stopped: false
    }, silentLogger, {
      runSudo: async args => {
        sudoCalls.push(args)
        return { stdout: '' }
      },
      waitForHealth: async () => makeFinalState()
    })

    assert.ok(sudoCalls.some(args => args[0] === 'cp' &&
      args.at(-2).endsWith('/meilisearch.toml.old') &&
      args.at(-1) === '/etc/meilisearch.toml'))
    assert.equal(sudoCalls.some(args => args[0] === 'cp' &&
      args.at(-2).endsWith('/meilisearch.old')), false)
  })
})

const silentLogger = { log () {}, warn () {}, error () {} }

function makeFinalState () {
  return {
    version: { pkgVersion: '1.51.0' },
    health: { status: 'available' },
    stats: { indexes: { events: { numberOfDocuments: 2 } } }
  }
}

function makeContext (strategy = 'dump') {
  let stateCalls = 0
  return {
    strategy,
    version: '1.51.0',
    currentVersion: '1.35.1',
    release: RELEASES['1.51.0'].x64,
    serviceName: 'meilisearch',
    pm2App: 'web.social-server',
    binaryPath: '/usr/local/bin/meilisearch',
    configPath: '/etc/meilisearch.toml',
    dataPath: '/var/lib/meilisearch/data',
    snapshotPath: '/var/lib/meilisearch/snapshots',
    dumpPath: '/var/lib/meilisearch/dumps',
    backupRoot: '/var/lib/meilisearch/upgrade-backups',
    serviceUser: 'meilisearch',
    serviceGroup: 'meilisearch',
    workingDirectory: '/var/lib/meilisearch',
    binaryOwner: 0,
    binaryGroup: 0,
    binaryMode: '755',
    configOwner: '0',
    configGroup: '0',
    configMode: '644',
    configChanges: [],
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
      },
      async createDump () {
        return { taskUid: 8 }
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
    writeTargetConfiguration: async () => {
      recordCall('prepare-config')
      return '/tmp/fake-upgrade/meilisearch.target.toml'
    },
    downloadRelease: async () => recordCall('download'),
    runCommand: async (file, args) => {
      if (args[0] === '--version') {
        recordCall('binary-version')
        return { stdout: 'meilisearch 1.51.0' }
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
      const originalDump = context.api.createDump
      context.api.state = async () => {
        recordCall('baseline')
        return original()
      }
      context.api.createSnapshot = async () => {
        recordCall('snapshot')
        return originalSnapshot()
      }
      context.api.createDump = async () => {
        recordCall('dump')
        return originalDump()
      }
    },
    waitForTask: async (_api, _uid, options) => {
      if (options.label.startsWith('dump task')) {
        recordCall('dump-wait')
        return { details: { dumpUid: '20260729-123456789' } }
      }
      recordCall('snapshot-wait')
      return {}
    },
    checkUpgradeDiskSpace: async () => recordCall('disk-recheck'),
    checkDumpImportDiskSpace: async () => recordCall('dump-space'),
    runDumplessUpgrade: async () => recordCall('dumpless'),
    runDumpImport: async () => recordCall('dump-import'),
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
  if (args[0] === 'chown' && args.at(-1).includes('/upgrade-backups/')) {
    return 'backup-owner'
  }
  if (args[0] === 'chmod' && args.at(-1).includes('/upgrade-backups/')) {
    return 'backup-mode'
  }
  if (args[0] === 'install') {
    return args.at(-1) === '/etc/meilisearch.toml'
      ? 'install-config'
      : 'install'
  }
  if (args[0] === 'mv') {
    if (args[1]?.endsWith('.dump')) return 'move-dump'
    if (args[1] === '/var/lib/meilisearch/data') return 'move-data'
  }
  const source = args.at(-2)
  if (source === '/usr/local/bin/meilisearch') return 'backup-old-binary'
  if (source === '/etc/meilisearch.toml') return 'backup-config'
  if (source?.endsWith('meilisearch-linux-amd64')) return 'backup-new-binary'
  if (source === '/var/lib/meilisearch/snapshots') return 'backup-snapshot'
  if (source === '/var/lib/meilisearch/data') return 'backup-data'
  return args.join(' ')
}
