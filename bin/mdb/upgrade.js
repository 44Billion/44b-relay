import '#config/dotenv.js'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  mkdtemp,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { Meilisearch } from 'meilisearch'

const execFile = promisify(execFileCallback)
const GIB = 1024 ** 3
const DEFAULT_TARGET_VERSION = '1.51.0'
const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'canceled'])
const DUMP_TARGET_DATA_RESERVE_FACTOR = 1.25
const DUMP_EXTRACTION_RESERVE_FACTOR = 1.1
const REMOVED_TARGET_CONFIG_OPTIONS = Object.freeze({
  '1.51.0': Object.freeze([
    'experimental_dumpless_upgrade'
  ])
})
const REVIEW_REQUIRED_TARGET_CONFIG_OPTIONS = Object.freeze({
  '1.51.0': Object.freeze([
    'experimental_no_edition_2024_for_dumps',
    'experimental_no_snapshot_compaction',
    'experimental_replication_parameters'
  ])
})

export const RELEASES = Object.freeze({
  '1.51.0': Object.freeze({
    x64: Object.freeze({
      asset: 'meilisearch-linux-amd64',
      sha256: '73f4f8809a80c5293a594de100b6121cb60879f9869875bdbc732c03771de560'
    }),
    arm64: Object.freeze({
      asset: 'meilisearch-linux-aarch64',
      sha256: '6da2eadedb3380df6a8beaf54a039375a4711e02c3e9ebeaf131f735c8f6bd4b'
    })
  })
})

export function parseArgs (argv) {
  const options = {
    execute: false,
    strategy: 'dump',
    version: DEFAULT_TARGET_VERSION,
    versionWasExplicit: false
  }
  for (const arg of argv) {
    if (arg === '--execute') options.execute = true
    else if (arg === '--dumpless') options.strategy = 'dumpless'
    else if (arg === '--help') options.help = true
    else if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length)
      options.versionWasExplicit = true
    } else {
      throw new TypeError(`Unknown option: ${arg}`)
    }
  }
  if (!RELEASES[options.version]) {
    throw new TypeError(
      `Unsupported target version ${options.version}; add its official checksums to RELEASES first`
    )
  }
  if (options.execute &&
      (!options.versionWasExplicit || options.version !== DEFAULT_TARGET_VERSION)) {
    throw new TypeError(
      `Execution requires --execute --version=${DEFAULT_TARGET_VERSION}`
    )
  }
  return options
}

export function validateLocalHost (host) {
  const url = new URL(host)
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  if (!['http:', 'https:'].includes(url.protocol) ||
      !localHosts.has(url.hostname) ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash) {
    throw new TypeError(`Refusing non-local Meilisearch host: ${host}`)
  }
  return url.origin
}

export function validateDataPath (value, label = 'data path') {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path: ${value}`)
  }
  const resolved = path.resolve(value)
  const parts = resolved.split(path.sep).filter(Boolean)
  if (resolved === path.parse(resolved).root || parts.length < 3) {
    throw new TypeError(`Refusing unsafe ${label}: ${value}`)
  }
  return resolved
}

export function validateFilePath (value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path: ${value}`)
  }
  const resolved = path.resolve(value)
  if (resolved === path.parse(resolved).root ||
      resolved === path.dirname(resolved)) {
    throw new TypeError(`Refusing unsafe ${label}: ${value}`)
  }
  return resolved
}

export function validateServiceIdentifier (value, label) {
  if (typeof value !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(value)) {
    throw new TypeError(`Invalid ${label}: ${value}`)
  }
  return value
}

export function validateNonOverlappingPaths (entries) {
  for (let left = 0; left < entries.length; left++) {
    for (let right = left + 1; right < entries.length; right++) {
      const [leftLabel, leftPath] = entries[left]
      const [rightLabel, rightPath] = entries[right]
      if (leftPath === rightPath ||
          leftPath.startsWith(`${rightPath}${path.sep}`) ||
          rightPath.startsWith(`${leftPath}${path.sep}`)) {
        throw new TypeError(
          `${leftLabel} and ${rightLabel} cannot overlap: ` +
          `${leftPath}, ${rightPath}`
        )
      }
    }
  }
}

export function dfAvailableArgs (directory) {
  // GNU df rejects the POSIX output flag (-P) together with --output.
  // -k keeps the values in KiB, which the free-space calculation expects.
  return ['-k', '--output=avail', directory]
}

export function detectS3SnapshotOptions ({
  configText = '',
  serviceEnvironment = '',
  execStart = ''
} = {}) {
  const options = new Set()
  for (const match of configText.matchAll(
    /^\s*((?:experimental_)?s3_[a-z0-9_]+)\s*=/gmi
  )) {
    options.add(`config:${match[1]}`)
  }
  for (const match of serviceEnvironment.matchAll(
    /\b(MEILI_(?:EXPERIMENTAL_)?S3_[A-Z0-9_]+)=/g
  )) {
    options.add(`environment:${match[1]}`)
  }
  for (const match of execStart.matchAll(
    /(?:^|\s)(--(?:experimental-)?s3-[a-z0-9-]+)(?:=|\s|$)/gi
  )) {
    options.add(`command:${match[1]}`)
  }
  return [...options].sort()
}

export function prepareTargetConfig (configText, targetVersion) {
  const removedOptions = new Set()
  const removableOptions =
    REMOVED_TARGET_CONFIG_OPTIONS[targetVersion] || []
  const reviewRequiredOptions =
    REVIEW_REQUIRED_TARGET_CONFIG_OPTIONS[targetVersion] || []
  const allTargetRemovedOptions = [
    ...removableOptions,
    ...reviewRequiredOptions
  ]
  const optionPattern = allTargetRemovedOptions
    .map(option => option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const activeOptions = new Set()
  const pattern = optionPattern
    ? new RegExp(
        `^[\\t ]*(${optionPattern})[\\t ]*=.*(?:\\r?\\n|$)`,
        'gm'
    )
    : null
  if (pattern) {
    for (const match of configText.matchAll(pattern)) {
      activeOptions.add(match[1])
    }
  }
  const text = pattern
    ? configText.replace(pattern, (line, option) => {
      if (removableOptions.includes(option)) {
        removedOptions.add(option)
        return ''
      }
      return line
    })
    : configText

  return {
    text,
    removedOptions: [...removedOptions].sort(),
    reviewRequiredOptions: reviewRequiredOptions
      .filter(option => activeOptions.has(option))
      .sort()
  }
}

function unquoteTomlString (value) {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value)
    } catch (cause) {
      throw new Error(`Could not parse TOML path ${value}`, { cause })
    }
  }
  return value.slice(1, -1)
}

export function resolveConfiguredDumpPath ({
  configText = '',
  serviceEnvironment = '',
  execStart = '',
  workingDirectory = process.cwd()
}) {
  const resolveFromWorkingDirectory = value => path.resolve(
    path.isAbsolute(value) ? value : path.join(workingDirectory, value)
  )
  const commandMatch = /--dump-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;]+))/.exec(
    execStart
  )
  if (commandMatch) {
    return {
      path: resolveFromWorkingDirectory(
        commandMatch[1] || commandMatch[2] || commandMatch[3]
      ),
      source: 'command:--dump-dir'
    }
  }
  const environmentMatch = /\bMEILI_DUMP_DIR=([^\s"]+)/.exec(
    serviceEnvironment
  )
  if (environmentMatch) {
    return {
      path: resolveFromWorkingDirectory(environmentMatch[1]),
      source: 'environment:MEILI_DUMP_DIR'
    }
  }
  const configMatch = /^\s*dump_dir\s*=\s*("[^"\n]*"|'[^'\n]*')\s*(?:#.*)?$/mi.exec(
    configText
  )
  if (configMatch) {
    return {
      path: resolveFromWorkingDirectory(unquoteTomlString(configMatch[1])),
      source: 'config:dump_dir'
    }
  }
  return {
    path: path.resolve(workingDirectory, 'dumps'),
    source: 'default'
  }
}

export function resolveServiceTmpPath ({
  serviceEnvironment = '',
  workingDirectory = process.cwd()
} = {}) {
  const match = /\bTMPDIR=([^\s"]+)/.exec(serviceEnvironment)
  const value = match?.[1] || '/tmp'
  return path.resolve(
    path.isAbsolute(value) ? value : path.join(workingDirectory, value)
  )
}

export function calculateRequiredFreeBytes ({ dataBytes, snapshotBytes }) {
  return dataBytes * 2 + snapshotBytes + GIB
}

export function calculateDumpCreationRequiredFreeBytes ({ dataBytes }) {
  // Dump creation stages an uncompressed logical copy before writing the
  // compressed archive. Reserve one full database for each plus headroom.
  return dataBytes * 2 + GIB
}

export function calculateDumpImportRequiredFreeBytes ({
  dataBytes,
  uncompressedDumpBytes
}) {
  const targetDataBytes = Math.ceil(
    dataBytes * DUMP_TARGET_DATA_RESERVE_FACTOR
  )
  const extractionBytes = Math.ceil(
    uncompressedDumpBytes * DUMP_EXTRACTION_RESERVE_FACTOR
  )
  return targetDataBytes + extractionBytes + GIB
}

export function sumTarEntryBytes (listing) {
  let total = 0
  for (const line of String(listing).split('\n')) {
    if (!line.trim()) continue
    const match = /^\S+\s+\d+\/\d+\s+(\d+)\s/.exec(line)
    if (!match) {
      throw new Error(`Could not parse dump archive entry: ${line}`)
    }
    total += Number(match[1])
    if (!Number.isSafeInteger(total)) {
      throw new Error('Dump archive is too large to measure safely')
    }
  }
  return total
}

function snapshotIndexState (stats) {
  return Object.fromEntries(
    Object.entries(stats.indexes || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([uid, value]) => [uid, value.numberOfDocuments])
  )
}

function versionParts (value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) throw new TypeError(`Invalid Meilisearch version: ${value}`)
  return match.slice(1).map(Number)
}

function compareVersions (a, b) {
  const aParts = versionParts(a)
  const bParts = versionParts(b)
  for (let index = 0; index < aParts.length; index++) {
    if (aParts[index] !== bParts[index]) return aParts[index] - bParts[index]
  }
  return 0
}

export function compareDatabaseState (before, after) {
  const expected = snapshotIndexState(before.stats)
  const actual = snapshotIndexState(after.stats)
  const errors = []
  if (after.version.pkgVersion !== before.targetVersion) {
    errors.push(
      `expected version ${before.targetVersion}, got ${after.version.pkgVersion}`
    )
  }
  if (after.health.status !== 'available') {
    errors.push(`health is ${after.health.status}`)
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(
      `index document counts changed: expected ${JSON.stringify(expected)}, ` +
      `got ${JSON.stringify(actual)}`
    )
  }
  return errors
}

function commandOutput (result) {
  return String(result.stdout || '').trim()
}

async function runCommand (file, args = [], options = {}) {
  return execFile(file, args, {
    maxBuffer: 20 * 1024 * 1024,
    ...options
  })
}

async function runSudo (args, options) {
  return runCommand('sudo', ['-n', ...args], options)
}

export async function assertSudoAuthorization ({
  runCommandFn = runCommand
} = {}) {
  try {
    await runCommandFn('sudo', ['-n', 'true'])
  } catch (cause) {
    const error = new Error(
      'Sudo authorization is not active. Run `sudo -v` in this same shell ' +
      'and retry the npm command. Do not run npm itself with sudo because ' +
      'PM2 must be controlled as the current user.',
      { cause }
    )
    error.code = 'SUDO_AUTH_REQUIRED'
    throw error
  }
}

export function startSudoKeepalive ({
  intervalMs = 60_000,
  renew = () => runSudo(['-v']),
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let stopped = false
  let timer
  let pendingRenewal = Promise.resolve()

  const schedule = () => {
    if (stopped) return
    timer = setTimer(refresh, intervalMs)
    timer?.unref?.()
  }
  const refresh = () => {
    if (stopped) return pendingRenewal
    pendingRenewal = Promise.resolve()
      .then(renew)
      .catch(error => {
        logger.error(
          '[mdb:upgrade] Could not refresh sudo authorization. The next ' +
          'privileged operation will stop rather than prompt unexpectedly.',
          error
        )
      })
      .finally(schedule)
    return pendingRenewal
  }

  schedule()
  return async function stopSudoKeepalive () {
    stopped = true
    clearTimer(timer)
    await pendingRenewal
  }
}

async function sha256File (file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

export async function downloadRelease (
  release,
  version,
  destination,
  { fetchFn = fetch } = {}
) {
  const url = `https://github.com/meilisearch/meilisearch/releases/download/v${version}/${release.asset}`
  const response = await fetchFn(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${url}: HTTP ${response.status}`)
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { flags: 'wx', mode: 0o755 })
  )
  const digest = await sha256File(destination)
  if (digest !== release.sha256) {
    throw new Error(
      `Checksum mismatch for ${release.asset}: expected ${release.sha256}, got ${digest}`
    )
  }
  await chmod(destination, 0o755)
}

function createApi ({ host, apiKey }) {
  const client = new Meilisearch({ host, apiKey })
  return {
    client,
    async state () {
      const [version, health, stats] = await Promise.all([
        client.getVersion(),
        client.health(),
        client.getStats()
      ])
      return { version, health, stats }
    },
    async activeTasks () {
      return client.tasks.getTasks({
        statuses: ['enqueued', 'processing'],
        reverse: true,
        limit: 20
      })
    },
    async createSnapshot () {
      return client.createSnapshot()
    },
    async createDump () {
      return client.createDump()
    },
    async getTask (uid) {
      return client.tasks.getTask(uid)
    },
    async upgradeTasks (afterEnqueuedAt) {
      return client.tasks.getTasks({
        types: ['upgradeDatabase'],
        afterEnqueuedAt,
        limit: 1
      })
    }
  }
}

async function wait (ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForTask (api, taskUid, {
  label = `task ${taskUid}`,
  timeoutMs = 2 * 60 * 60 * 1000,
  logger = console
} = {}) {
  const startedAt = Date.now()
  let lastStatus
  while (Date.now() - startedAt < timeoutMs) {
    const task = await api.getTask(taskUid)
    if (task.status !== lastStatus) {
      logger.log(`[mdb:upgrade] ${label}: ${task.status}`)
      lastStatus = task.status
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      if (task.status !== 'succeeded') {
        const error = new Error(`${label} ${task.status}: ${JSON.stringify(task.error)}`)
        error.task = task
        throw error
      }
      return task
    }
    await wait(1000)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function waitForHealth (api, {
  timeoutMs = 120000,
  expectedVersion,
  logger = console
} = {}) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const state = await api.state()
      if (state.health.status === 'available' &&
          (!expectedVersion || state.version.pkgVersion === expectedVersion)) {
        return state
      }
      lastError = new Error(
        `version=${state.version.pkgVersion}, health=${state.health.status}`
      )
    } catch (error) {
      lastError = error
    }
    await wait(1000)
  }
  logger.error('[mdb:upgrade] Last health error:', lastError)
  throw new Error('Meilisearch did not become healthy in time', { cause: lastError })
}

async function nearestExistingParent (value) {
  let current = path.resolve(value)
  while (true) {
    try {
      await access(current, fsConstants.F_OK)
      return current
    } catch {}
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`No existing parent for ${value}`)
    current = parent
  }
}

export async function checkUpgradeDiskSpace (context, {
  runSudoFn = runSudo,
  logger,
  phase = 'preflight'
} = {}) {
  const backupParent =
    context.backupParent || await nearestExistingParent(context.backupRoot)
  const [dataSizeResult, snapshotSizeResult, freeResult] = await Promise.all([
    runSudoFn(['du', '-sb', context.dataPath]),
    runSudoFn(['du', '-sb', context.snapshotPath]),
    runSudoFn(['df', ...dfAvailableArgs(backupParent)])
  ])
  const dataBytes = Number(commandOutput(dataSizeResult).split(/\s+/)[0])
  const snapshotBytes = Number(
    commandOutput(snapshotSizeResult).split(/\s+/)[0]
  )
  const freeKilobytes = Number(
    commandOutput(freeResult).split('\n').at(-1).trim()
  )
  const freeBytes = freeKilobytes * 1024
  const requiredFreeBytes = calculateRequiredFreeBytes({
    dataBytes,
    snapshotBytes
  })
  if (!Number.isSafeInteger(dataBytes) ||
      !Number.isSafeInteger(snapshotBytes) ||
      !Number.isSafeInteger(freeBytes)) {
    throw new Error('Could not determine data size or free disk space')
  }
  if (freeBytes < requiredFreeBytes) {
    throw new Error(
      `Insufficient disk space during ${phase}: ${freeBytes} bytes free, ` +
      `${requiredFreeBytes} required for snapshot backup, cold copy, and rollback`
    )
  }
  const result = {
    backupParent,
    dataBytes,
    snapshotBytes,
    freeBytes,
    requiredFreeBytes
  }
  if (logger) {
    logger.log(
      `[mdb:upgrade] ${phase} disk check passed: ${freeBytes} bytes free, ` +
      `${requiredFreeBytes} required.`
    )
  }
  return result
}

export async function checkDumpCreationDiskSpace (context, {
  runSudoFn = runSudo,
  logger,
  phase = 'preflight'
} = {}) {
  const backupParent =
    context.backupParent || await nearestExistingParent(context.backupRoot)
  const [dataSizeResult, freeResult] = await Promise.all([
    runSudoFn(['du', '-sb', context.dataPath]),
    runSudoFn(['df', ...dfAvailableArgs(backupParent)])
  ])
  const dataBytes = Number(commandOutput(dataSizeResult).split(/\s+/)[0])
  const freeKilobytes = Number(
    commandOutput(freeResult).split('\n').at(-1).trim()
  )
  const freeBytes = freeKilobytes * 1024
  const requiredFreeBytes = calculateDumpCreationRequiredFreeBytes({
    dataBytes
  })
  if (!Number.isSafeInteger(dataBytes) ||
      !Number.isSafeInteger(freeBytes)) {
    throw new Error('Could not determine data size or free disk space')
  }
  if (freeBytes < requiredFreeBytes) {
    throw new Error(
      `Insufficient disk space during ${phase}: ${freeBytes} bytes free, ` +
      `${requiredFreeBytes} required to stage and write the migration dump`
    )
  }
  const result = {
    backupParent,
    dataBytes,
    freeBytes,
    requiredFreeBytes
  }
  if (logger) {
    logger.log(
      `[mdb:upgrade] ${phase} dump-creation disk check passed: ` +
      `${freeBytes} bytes free, ${requiredFreeBytes} required.`
    )
  }
  return result
}

export async function checkDumpImportDiskSpace (context, dumpFile, {
  runSudoFn = runSudo,
  logger,
  phase = 'post-dump'
} = {}) {
  const backupParent =
    context.backupParent || await nearestExistingParent(context.backupRoot)
  await runSudoFn(['test', '-f', dumpFile])
  const [
    dataSizeResult,
    dumpSizeResult,
    archiveListingResult,
    freeResult
  ] = await Promise.all([
    runSudoFn(['du', '-sb', context.dataPath]),
    runSudoFn(['stat', '-c', '%s', dumpFile]),
    runSudoFn([
      'tar',
      '--list',
      '--verbose',
      '--gzip',
      '--numeric-owner',
      '--file',
      dumpFile
    ]),
    runSudoFn(['df', ...dfAvailableArgs(backupParent)])
  ])
  const dataBytes = Number(commandOutput(dataSizeResult).split(/\s+/)[0])
  const dumpBytes = Number(commandOutput(dumpSizeResult))
  const uncompressedDumpBytes = sumTarEntryBytes(
    commandOutput(archiveListingResult)
  )
  const freeKilobytes = Number(
    commandOutput(freeResult).split('\n').at(-1).trim()
  )
  const freeBytes = freeKilobytes * 1024
  const requiredFreeBytes = calculateDumpImportRequiredFreeBytes({
    dataBytes,
    uncompressedDumpBytes
  })
  if (!Number.isSafeInteger(dataBytes) ||
      !Number.isSafeInteger(dumpBytes) ||
      !Number.isSafeInteger(uncompressedDumpBytes) ||
      !Number.isSafeInteger(freeBytes)) {
    throw new Error('Could not determine dump size or free disk space')
  }
  if (freeBytes < requiredFreeBytes) {
    throw new Error(
      `Insufficient disk space during ${phase}: ${freeBytes} bytes free ` +
      `after creating the ${dumpBytes}-byte dump, but ${requiredFreeBytes} ` +
      'are reserved for extraction, the rebuilt database, and rollback'
    )
  }
  const result = {
    backupParent,
    dataBytes,
    dumpBytes,
    uncompressedDumpBytes,
    freeBytes,
    requiredFreeBytes
  }
  if (logger) {
    logger.log(
      `[mdb:upgrade] ${phase} dump-import disk check passed: ` +
      `${freeBytes} bytes free, ${requiredFreeBytes} required ` +
      `(${dumpBytes}-byte compressed dump, ` +
      `${uncompressedDumpBytes} bytes unpacked).`
    )
  }
  return result
}

async function removeTemporaryDownload (directory) {
  const resolved = path.resolve(directory)
  const expectedParent = path.resolve(tmpdir())
  if (path.dirname(resolved) !== expectedParent ||
      !path.basename(resolved).startsWith('meilisearch-upgrade-')) {
    throw new TypeError(`Refusing to remove unexpected temporary path: ${directory}`)
  }
  await rm(resolved, { recursive: true, force: true })
}

async function writeTargetConfiguration (directory, configText) {
  const target = path.join(directory, 'meilisearch.target.toml')
  await writeFile(target, configText, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  })
  return target
}

function environmentConfig () {
  const dataPath = validateDataPath(
    process.env.MDB_UPGRADE_DATA_PATH || '/var/lib/meilisearch/data'
  )
  const backupRoot = validateDataPath(
    process.env.MDB_UPGRADE_BACKUP_ROOT ||
      '/var/lib/meilisearch/upgrade-backups',
    'backup root'
  )
  const snapshotPath = validateDataPath(
    process.env.MDB_UPGRADE_SNAPSHOT_PATH ||
      '/var/lib/meilisearch/snapshots',
    'snapshot path'
  )
  const dumpPath = validateDataPath(
    process.env.MDB_UPGRADE_DUMP_PATH ||
      '/var/lib/meilisearch/dumps',
    'dump path'
  )
  validateNonOverlappingPaths([
    ['active data path', dataPath],
    ['snapshot path', snapshotPath],
    ['dump path', dumpPath],
    ['backup root', backupRoot]
  ])
  return {
    host: validateLocalHost(
      process.env.MDB_UPGRADE_HOST ||
      process.env.MDB_HOST ||
      'http://127.0.0.1:7700'
    ),
    apiKey: process.env.MDB_API_KEY || 'meilisearchmasterkey',
    binaryPath: validateFilePath(
      process.env.MDB_UPGRADE_BINARY_PATH || '/usr/local/bin/meilisearch',
      'binary path'
    ),
    configPath: validateFilePath(
      process.env.MDB_UPGRADE_CONFIG_PATH || '/etc/meilisearch.toml',
      'configuration path'
    ),
    dataPath,
    snapshotPath,
    dumpPath,
    backupRoot,
    serviceName: validateServiceIdentifier(
      process.env.MDB_UPGRADE_SERVICE || 'meilisearch',
      'systemd service name'
    ),
    pm2App: validateServiceIdentifier(
      process.env.MDB_UPGRADE_PM2_APP || 'web.social-server',
      'PM2 application name'
    )
  }
}

async function inspectEnvironment ({
  version,
  strategy = 'dump',
  logger = console,
  platform = process.platform,
  arch = process.arch
} = {}) {
  if (platform !== 'linux') {
    throw new TypeError(`The guarded upgrade only supports Linux, not ${platform}`)
  }
  const release = RELEASES[version]?.[arch]
  if (!release) throw new TypeError(`No checked release for architecture ${arch}`)

  const config = environmentConfig()
  const requiredCommands = [
    runCommand('which', ['pm2']),
    runCommand('which', ['systemctl']),
    runCommand('which', ['systemd-run']),
    runCommand('which', ['sudo'])
  ]
  if (strategy === 'dump') {
    requiredCommands.push(runCommand('which', ['tar']))
  }
  await Promise.all(requiredCommands)
  await assertSudoAuthorization()
  const requiredPaths = [
    runSudo(['test', '-x', config.binaryPath]),
    runSudo(['test', '-f', config.configPath]),
    runSudo(['test', '-d', config.dataPath])
  ]
  if (strategy === 'dumpless') {
    requiredPaths.push(runSudo(['test', '-d', config.snapshotPath]))
  }
  await Promise.all(requiredPaths)

  const [pm2Result, systemdState, serviceProperties, configContents] =
    await Promise.all([
      runCommand('pm2', ['jlist']),
      runSudo(['systemctl', 'is-active', config.serviceName]),
      runSudo([
        'systemctl',
        'show',
        config.serviceName,
        '--property=User',
        '--property=Group',
        '--property=WorkingDirectory',
        '--property=ExecStart',
        '--property=Environment'
      ]),
      runSudo(['cat', config.configPath])
    ])
  if (commandOutput(systemdState) !== 'active') {
    throw new Error(`${config.serviceName} systemd service is not active`)
  }

  const pm2Processes = JSON.parse(commandOutput(pm2Result))
    .filter(processInfo => processInfo.name === config.pm2App)
  if (!pm2Processes.length) {
    throw new Error(`No PM2 process named ${config.pm2App}`)
  }
  if (!pm2Processes.every(processInfo =>
    processInfo.pm2_env?.status === 'online')) {
    throw new Error(`Not every PM2 process named ${config.pm2App} is online`)
  }

  const properties = Object.fromEntries(
    commandOutput(serviceProperties)
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const index = line.indexOf('=')
        return [line.slice(0, index), line.slice(index + 1)]
      })
  )
  const serviceUser = properties.User || 'meilisearch'
  const serviceGroup = properties.Group || serviceUser
  const workingDirectory =
    properties.WorkingDirectory || path.dirname(config.dataPath)
  if (!properties.ExecStart?.includes(config.binaryPath)) {
    throw new Error(
      `${config.serviceName} ExecStart does not reference ${config.binaryPath}`
    )
  }
  const configText = String(configContents.stdout || '')
  const targetConfig = prepareTargetConfig(configText, version)
  if (targetConfig.reviewRequiredOptions.length) {
    throw new Error(
      `Meilisearch ${version} removed configuration option(s) that require ` +
      `manual review: ${targetConfig.reviewRequiredOptions.join(', ')}. ` +
      'Remove or replace them before rerunning the dry-run.'
    )
  }
  const configuredDump = resolveConfiguredDumpPath({
    configText,
    serviceEnvironment: properties.Environment,
    execStart: properties.ExecStart,
    workingDirectory
  })
  const serviceTmpPath = resolveServiceTmpPath({
    serviceEnvironment: properties.Environment,
    workingDirectory
  })
  if (strategy === 'dump') {
    if (configuredDump.path !== config.dumpPath) {
      throw new Error(
        `Meilisearch writes dumps to ${configuredDump.path} ` +
        `(${configuredDump.source}), but the upgrade helper expects ` +
        `${config.dumpPath}. Set MDB_UPGRADE_DUMP_PATH=${configuredDump.path} ` +
        'or make the Meilisearch dump_dir match.'
      )
    }
    try {
      await Promise.all([
        runSudo(['test', '-d', config.dumpPath]),
        runSudo(['test', '-d', serviceTmpPath])
      ])
    } catch (cause) {
      throw new Error(
        `The dump directory (${config.dumpPath}) and service TMPDIR ` +
        `(${serviceTmpPath}) must both exist before dump migration.`,
        { cause }
      )
    }
  }
  const s3SnapshotOptions = detectS3SnapshotOptions({
    configText,
    serviceEnvironment: properties.Environment,
    execStart: properties.ExecStart
  })
  if (strategy === 'dumpless' && s3SnapshotOptions.length) {
    throw new Error(
      'S3 snapshot configuration is active (' +
      `${s3SnapshotOptions.join(', ')}). The Community Edition cannot create ` +
      'the required upgrade snapshot. Remove the S3 snapshot options, keep a ' +
      'local snapshot_dir, restart Meilisearch, and rerun the dry-run.'
    )
  }
  if (strategy === 'dump' && s3SnapshotOptions.length) {
    logger.warn(
      '[mdb:upgrade] S3 snapshot configuration is active (' +
      `${s3SnapshotOptions.join(', ')}). It does not affect dump migration, ` +
      'but Community Edition snapshot requests will continue to fail until ' +
      'these options are removed.'
    )
  }

  const backupParent = await nearestExistingParent(config.backupRoot)
  const [
    dataDeviceResult,
    backupDeviceResult,
    strategyDeviceResult,
    tmpDeviceResult,
    configStatResult,
    binaryStat,
    diskSpace
  ] =
    await Promise.all([
      runSudo(['stat', '-c', '%d', config.dataPath]),
      runSudo(['stat', '-c', '%d', backupParent]),
      runSudo([
        'stat',
        '-c',
        '%d',
        strategy === 'dump' ? config.dumpPath : config.dataPath
      ]),
      runSudo([
        'stat',
        '-c',
        '%d',
        strategy === 'dump' ? serviceTmpPath : config.dataPath
      ]),
      runSudo(['stat', '-c', '%u %g %a', config.configPath]),
      stat(config.binaryPath),
      strategy === 'dump'
        ? checkDumpCreationDiskSpace({ ...config, backupParent })
        : checkUpgradeDiskSpace({ ...config, backupParent })
    ])
  if (commandOutput(dataDeviceResult) !== commandOutput(backupDeviceResult)) {
    throw new Error('Active data and backup root must be on the same filesystem')
  }
  if (strategy === 'dump' &&
      commandOutput(dataDeviceResult) !== commandOutput(strategyDeviceResult)) {
    throw new Error(
      'Active data, dump path, and backup root must be on the same filesystem ' +
      'so the source database and dump can be moved without copying'
    )
  }
  if (strategy === 'dump' &&
      commandOutput(dataDeviceResult) !== commandOutput(tmpDeviceResult)) {
    throw new Error(
      `Meilisearch TMPDIR ${serviceTmpPath} is on a different filesystem. ` +
      'Configure TMPDIR on the data filesystem and restart Meilisearch so ' +
      'dump staging is covered by the disk-space guard.'
    )
  }

  const {
    dataBytes,
    freeBytes,
    requiredFreeBytes
  } = diskSpace
  const snapshotBytes = diskSpace.snapshotBytes
  const [
    configOwner,
    configGroup,
    configMode
  ] = commandOutput(configStatResult).split(/\s+/)
  if (![configOwner, configGroup, configMode].every(value => /^\d+$/.test(value))) {
    throw new Error('Could not determine Meilisearch configuration ownership')
  }

  const api = createApi(config)
  const state = await api.state()
  if (state.health.status !== 'available') {
    throw new Error(`Meilisearch health is ${state.health.status}`)
  }
  if (state.version.pkgVersion === version) {
    throw new Error(`Meilisearch is already at ${version}`)
  }
  if (strategy === 'dumpless' &&
      compareVersions(state.version.pkgVersion, '1.12.0') < 0) {
    throw new Error(
      `Dumpless upgrade requires Meilisearch >= 1.12.0; found ${state.version.pkgVersion}`
    )
  }
  if (compareVersions(state.version.pkgVersion, version) > 0) {
    throw new Error(
      `Refusing to downgrade ${state.version.pkgVersion} to ${version}`
    )
  }

  const inspected = {
    ...config,
    version,
    strategy,
    release,
    api,
    currentVersion: state.version.pkgVersion,
    currentState: state,
    serviceUser,
    serviceGroup,
    workingDirectory,
    targetConfigText: targetConfig.text,
    configChanges: targetConfig.removedOptions.map(
      option => `remove obsolete ${option}`
    ),
    configOwner,
    configGroup,
    configMode,
    serviceTmpPath,
    backupParent,
    dataBytes,
    snapshotBytes,
    freeBytes,
    requiredFreeBytes,
    s3SnapshotOptions,
    binaryOwner: binaryStat.uid,
    binaryGroup: binaryStat.gid,
    binaryMode: (binaryStat.mode & 0o777).toString(8),
    pm2Instances: pm2Processes.length
  }
  logger.log(JSON.stringify({
    host: inspected.host,
    strategy: inspected.strategy,
    currentVersion: inspected.currentVersion,
    targetVersion: inspected.version,
    architecture: arch,
    releaseAsset: release.asset,
    releaseSha256: release.sha256,
    binaryPath: inspected.binaryPath,
    configPath: inspected.configPath,
    dataPath: inspected.dataPath,
    ...(strategy === 'dump'
      ? {
          dumpPath: inspected.dumpPath,
          serviceTmpPath: inspected.serviceTmpPath
        }
      : { snapshotPath: inspected.snapshotPath }),
    backupRoot: inspected.backupRoot,
    dataBytes,
    ...(snapshotBytes === undefined ? {} : { snapshotBytes }),
    freeBytes,
    requiredFreeBytes,
    serviceName: inspected.serviceName,
    pm2App: inspected.pm2App,
    pm2Instances: inspected.pm2Instances,
    configChanges: inspected.configChanges
  }, null, 2))
  return inspected
}

async function drainQueue (context, logger = console) {
  const timeoutMs = Number(process.env.MDB_UPGRADE_DRAIN_TIMEOUT_MS || 30 * 60 * 1000)
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const active = await context.api.activeTasks()
    if (active.total === 0) return
    const oldest = active.results[0]
    logger.log(
      `[mdb:upgrade] Waiting for ${active.total} task(s); oldest is ` +
      `${oldest?.uid ?? 'unknown'} (${oldest?.type ?? 'unknown'})`
    )
    await wait(1000)
  }
  throw new Error('Timed out draining the Meilisearch task queue')
}

async function runDumplessUpgrade (context, state, logger = console) {
  const unit = `meilisearch-upgrade-${Date.now()}`
  state.transientUnit = unit
  const afterEnqueuedAt = new Date(Date.now() - 5000).toISOString()
  await runSudo([
    'systemd-run',
    `--unit=${unit}`,
    '--collect',
    '--service-type=exec',
    `--uid=${context.serviceUser}`,
    `--gid=${context.serviceGroup}`,
    `--working-directory=${context.workingDirectory}`,
    context.binaryPath,
    '--config-file-path',
    context.configPath,
    '--upgrade-db'
  ])

  try {
    await waitForHealth(context.api)
    let upgradeTask
    const startedAt = Date.now()
    while (!upgradeTask && Date.now() - startedAt < 120000) {
      const tasks = await context.api.upgradeTasks(afterEnqueuedAt)
      upgradeTask = tasks.results[0]
      if (!upgradeTask) await wait(500)
    }
    if (!upgradeTask) throw new Error('No upgradeDatabase task was created')
    await waitForTask(context.api, upgradeTask.uid, {
      label: `upgradeDatabase task ${upgradeTask.uid}`,
      logger
    })
  } finally {
    await runSudo(['systemctl', 'stop', unit]).catch(() => {})
  }
}

export function dumpFileForTask (context, task) {
  const dumpUid = task?.details?.dumpUid
  if (typeof dumpUid !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(dumpUid) ||
      dumpUid === '.' ||
      dumpUid === '..') {
    throw new Error(
      `Dump task did not return a safe dump UID: ${JSON.stringify(dumpUid)}`
    )
  }
  return path.join(context.dumpPath, `${dumpUid}.dump`)
}

async function runDumpImport (
  context,
  state,
  dumpFile,
  logger = console
) {
  const unit = `meilisearch-import-${Date.now()}`
  const importTempPath = path.join(state.backupDir, 'import-tmp')
  const timeoutMs = Number(
    process.env.MDB_UPGRADE_IMPORT_TIMEOUT_MS || 12 * 60 * 60 * 1000
  )
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('MDB_UPGRADE_IMPORT_TIMEOUT_MS must be a positive integer')
  }
  state.transientUnit = unit
  state.importTempPath = importTempPath
  await runSudo(['mkdir', '-p', importTempPath])
  await runSudo([
    'chown',
    `${context.serviceUser}:${context.serviceGroup}`,
    importTempPath
  ])
  await runSudo([
    'systemd-run',
    `--unit=${unit}`,
    '--collect',
    '--service-type=exec',
    `--uid=${context.serviceUser}`,
    `--gid=${context.serviceGroup}`,
    `--working-directory=${context.workingDirectory}`,
    `--setenv=TMPDIR=${importTempPath}`,
    context.binaryPath,
    '--config-file-path',
    context.configPath,
    '--import-dump',
    dumpFile
  ])

  const startedAt = Date.now()
  let lastError
  let nextProgressLogAt = startedAt
  try {
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const importedState = await context.api.state()
        if (importedState.health.status === 'available' &&
            importedState.version.pkgVersion === context.version) {
          return importedState
        }
        lastError = new Error(
          `version=${importedState.version.pkgVersion}, ` +
          `health=${importedState.health.status}`
        )
      } catch (error) {
        lastError = error
      }

      let unitState
      try {
        unitState = commandOutput(await runSudo([
          'systemctl',
          'is-active',
          unit
        ]))
      } catch {
        unitState = 'inactive'
      }
      if (!['active', 'activating'].includes(unitState)) {
        let logs = ''
        try {
          logs = commandOutput(await runSudo([
            'journalctl',
            '--unit',
            unit,
            '--no-pager',
            '--lines',
            '80'
          ]))
        } catch {}
        throw new Error(
          `Dump import unit ${unit} stopped before Meilisearch became ` +
          `available.${logs ? `\n${logs}` : ''}`,
          { cause: lastError }
        )
      }
      if (Date.now() >= nextProgressLogAt) {
        logger.log(
          `[mdb:upgrade] Dump import is still running in ${unit}; ` +
          'Meilisearch remains offline until reindexing completes.'
        )
        nextProgressLogAt = Date.now() + 30_000
      }
      await wait(2000)
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for dump import`,
      { cause: lastError }
    )
  } finally {
    await runSudo(['systemctl', 'stop', unit]).catch(() => {})
    try {
      await runSudo([
        'rm',
        '-rf',
        '--one-file-system',
        '--',
        importTempPath
      ])
      state.importTempPath = null
    } catch (error) {
      logger.warn(
        `[mdb:upgrade] Could not remove import staging path ${importTempPath}:`,
        error
      )
    }
  }
}

export async function rollback (context, state, logger = console, operations = {}) {
  const op = {
    runSudo,
    runCommand,
    waitForHealth,
    ...operations
  }
  logger.error('[mdb:upgrade] Upgrade failed; starting automatic rollback.')
  if (state.transientUnit) {
    await op.runSudo(['systemctl', 'stop', state.transientUnit]).catch(() => {})
  }
  if (state.importTempPath) {
    await op.runSudo([
      'rm',
      '-rf',
      '--one-file-system',
      '--',
      state.importTempPath
    ]).catch(() => {})
  }
  if (state.mdbStopped ||
      state.normalMdbStarted ||
      state.backupReady ||
      state.dataMoveStarted ||
      state.configInstallStarted ||
      state.binaryInstallStarted) {
    await op.runSudo(['systemctl', 'stop', context.serviceName]).catch(() => {})
  }

  if (state.strategy === 'dump' && state.dataMoveStarted) {
    const oldDataPath =
      state.oldDataPath || path.join(state.backupDir, 'data.old')
    const failedDataPath = path.join(state.backupDir, 'data.failed')
    let oldDataExists = true
    try {
      await op.runSudo(['test', '-e', oldDataPath])
    } catch {
      oldDataExists = false
    }
    if (oldDataExists) {
      let activeDataExists = true
      try {
        await op.runSudo(['test', '-e', context.dataPath])
      } catch {
        activeDataExists = false
      }
      if (activeDataExists) {
        await op.runSudo(['mv', context.dataPath, failedDataPath])
      }
      await op.runSudo(['mv', oldDataPath, context.dataPath])
      if (activeDataExists) {
        await op.runSudo([
          'rm',
          '-rf',
          '--one-file-system',
          '--',
          failedDataPath
        ])
      }
    }
  } else if (state.backupReady) {
    const failedDataPath = path.join(state.backupDir, 'data.failed')
    let activeDataExists = true
    try {
      await op.runSudo(['test', '-e', context.dataPath])
    } catch {
      activeDataExists = false
    }
    if (activeDataExists) {
      await op.runSudo(['mv', context.dataPath, failedDataPath])
    }
    await op.runSudo(['cp', '-a', path.join(state.backupDir, 'data.cold'), context.dataPath])
  }

  if (state.binaryInstallStarted) {
    await op.runSudo(['cp', '-a', path.join(state.backupDir, 'meilisearch.old'), context.binaryPath])
  }
  if (state.configInstallStarted || state.binaryInstallStarted) {
    await op.runSudo(['cp', '-a', path.join(state.backupDir, 'meilisearch.toml.old'), context.configPath])
  }

  if (state.mdbStopped ||
      state.normalMdbStarted ||
      state.backupReady ||
      state.dataMoveStarted ||
      state.configInstallStarted ||
      state.binaryInstallStarted) {
    await op.runSudo(['systemctl', 'start', context.serviceName])
    await op.waitForHealth(context.api, {
      expectedVersion: context.currentVersion,
      logger
    })
  }
  if (state.pm2Stopped) {
    await op.runCommand('pm2', ['restart', context.pm2App])
  }
  logger.log(
    state.strategy === 'dump' && state.dataMoveStarted
      ? '[mdb:upgrade] Rollback completed; the original database was moved ' +
        'back into service and the migration dump was retained.'
      : state.backupReady
        ? '[mdb:upgrade] Rollback completed; all backup material was retained.'
        : '[mdb:upgrade] Recovery completed before data or binary replacement; PM2 was restored.'
  )
}

export async function executeUpgrade (context, {
  logger = console,
  operations = {}
} = {}) {
  const state = {
    strategy: context.strategy || 'dump',
    pm2Stopped: false,
    mdbStopped: false,
    normalMdbStarted: false,
    backupReady: false,
    dataMoveStarted: false,
    configInstallStarted: false,
    binaryInstallStarted: false,
    transientUnit: null,
    backupDir: null,
    oldDataPath: null,
    importTempPath: null
  }
  const op = {
    mkdtemp,
    downloadRelease,
    runCommand,
    runSudo,
    drainQueue,
    waitForTask,
    checkUpgradeDiskSpace,
    checkDumpImportDiskSpace,
    writeTargetConfiguration,
    runDumplessUpgrade,
    runDumpImport,
    waitForHealth,
    rollback,
    removeTemporaryDownload,
    ...operations
  }
  let tempDir
  let targetConfigPath

  try {
    tempDir = await op.mkdtemp(path.join(tmpdir(), 'meilisearch-upgrade-'))
    if (context.configChanges?.length) {
      targetConfigPath = await op.writeTargetConfiguration(
        tempDir,
        context.targetConfigText
      )
      logger.log(
        '[mdb:upgrade] Prepared target configuration: ' +
        `${context.configChanges.join(', ')}.`
      )
    }
    const downloadedBinary = path.join(tempDir, context.release.asset)
    logger.log(`[mdb:upgrade] Downloading checked release to ${downloadedBinary}`)
    await op.downloadRelease(
      context.release,
      context.version,
      downloadedBinary
    )
    const downloadedVersion = commandOutput(
      await op.runCommand(downloadedBinary, ['--version'])
    )
    if (!downloadedVersion.includes(context.version)) {
      throw new Error(`Downloaded binary reports unexpected version: ${downloadedVersion}`)
    }

    state.pm2Stopped = true
    await op.runCommand('pm2', ['stop', context.pm2App])
    await op.drainQueue(context, logger)
    const baseline = await context.api.state()

    let dumpFile
    if (state.strategy === 'dump') {
      const dump = await context.api.createDump()
      const dumpTask = await op.waitForTask(context.api, dump.taskUid, {
        label: `dump task ${dump.taskUid}`,
        logger
      })
      dumpFile = dumpFileForTask(context, dumpTask)
      await op.checkDumpImportDiskSpace(context, dumpFile, {
        logger,
        phase: 'post-dump'
      })
    } else {
      const snapshot = await context.api.createSnapshot()
      await op.waitForTask(context.api, snapshot.taskUid, {
        label: `snapshot task ${snapshot.taskUid}`,
        logger
      })
      await op.checkUpgradeDiskSpace(context, {
        logger,
        phase: 'post-snapshot'
      })
    }

    const stamp = new Date().toISOString().replaceAll(':', '-')
    state.backupDir = path.join(
      context.backupRoot,
      `${stamp}-${state.strategy}-from-${context.currentVersion}-to-${context.version}`
    )
    await op.runSudo(['mkdir', '-p', state.backupDir])
    await op.runSudo([
      'chown',
      `0:${context.serviceGroup}`,
      state.backupDir
    ])
    await op.runSudo(['chmod', '750', state.backupDir])
    await op.runSudo(['cp', '-a', context.binaryPath, path.join(state.backupDir, 'meilisearch.old')])
    await op.runSudo(['cp', '-a', context.configPath, path.join(state.backupDir, 'meilisearch.toml.old')])
    await op.runSudo(['cp', '-a', downloadedBinary, path.join(state.backupDir, 'meilisearch.new')])

    state.mdbStopped = true
    await op.runSudo(['systemctl', 'stop', context.serviceName])

    if (targetConfigPath) {
      state.configInstallStarted = true
      await op.runSudo([
        'install',
        `--owner=${context.configOwner}`,
        `--group=${context.configGroup}`,
        `--mode=${context.configMode}`,
        targetConfigPath,
        context.configPath
      ])
    }

    if (state.strategy === 'dump') {
      const retainedDump = path.join(state.backupDir, 'migration.dump')
      await op.runSudo(['mv', dumpFile, retainedDump])
      dumpFile = retainedDump
      state.oldDataPath = path.join(state.backupDir, 'data.old')
      state.dataMoveStarted = true
      await op.runSudo(['mv', context.dataPath, state.oldDataPath])
      state.backupReady = true
    } else {
      await op.runSudo(['cp', '-a', context.snapshotPath, path.join(state.backupDir, 'snapshot')])
      await op.runSudo(['cp', '-a', '--reflink=auto', context.dataPath, path.join(state.backupDir, 'data.cold')])
      state.backupReady = true
    }

    state.binaryInstallStarted = true
    await op.runSudo([
      'install',
      `--owner=${context.binaryOwner}`,
      `--group=${context.binaryGroup}`,
      `--mode=${context.binaryMode}`,
      downloadedBinary,
      context.binaryPath
    ])
    if (state.strategy === 'dump') {
      await op.runDumpImport(context, state, dumpFile, logger)
    } else {
      await op.runDumplessUpgrade(context, state, logger)
    }

    await op.runSudo(['systemctl', 'start', context.serviceName])
    state.normalMdbStarted = true
    const finalState = await op.waitForHealth(context.api, {
      expectedVersion: context.version,
      logger
    })
    const validationErrors = compareDatabaseState({
      ...baseline,
      targetVersion: context.version
    }, finalState)
    if (validationErrors.length) {
      throw new Error(`Post-upgrade validation failed: ${validationErrors.join('; ')}`)
    }

    await op.runCommand('pm2', ['restart', context.pm2App])
    state.pm2Stopped = false
    logger.log(
      `[mdb:upgrade] ${state.strategy} upgrade to ${context.version} completed. ` +
      `Backups remain at ${state.backupDir}.`
    )
    return {
      strategy: state.strategy,
      backupDir: state.backupDir,
      finalState
    }
  } catch (error) {
    try {
      await op.rollback(context, state, logger, op)
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Upgrade failed and automatic rollback also failed'
      )
    }
    throw error
  } finally {
    if (tempDir) {
      await op.removeTemporaryDownload(tempDir).catch(error => {
        logger.warn(
          `[mdb:upgrade] Could not remove temporary download ${tempDir}:`,
          error
        )
      })
    }
  }
}

async function main () {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(`Usage:
  npm run mdb:upgrade
  npm run mdb:upgrade -- --execute --version=${DEFAULT_TARGET_VERSION}
  npm run mdb:upgrade -- --dumpless
  npm run mdb:upgrade -- --execute --version=${DEFAULT_TARGET_VERSION} --dumpless

The default is a read-only dry-run of the dump strategy. Execution is accepted
only with both explicit flags. Pass --dumpless to opt into the in-place
--upgrade-db strategy, which additionally requires a local snapshot and cold
copy. Paths and service names may be configured with MDB_UPGRADE_* environment
variables; use only absolute local paths.

If sudo requires a password, first run \`sudo -v\` in the same shell. Do not
run npm itself with sudo because PM2 is scoped to the current user.`)
    return
  }

  const context = await inspectEnvironment({
    version: options.version,
    strategy: options.strategy
  })
  if (!options.execute) {
    console.log(
      `[mdb:upgrade] ${options.strategy} dry-run complete. No download, ` +
      'service stop, backup, copy, or database mutation was performed.'
    )
    return
  }
  const stopSudoKeepalive = startSudoKeepalive()
  try {
    await executeUpgrade(context)
  } finally {
    await stopSudoKeepalive()
  }
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}

export { inspectEnvironment }
