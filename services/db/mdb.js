// https://www.meilisearch.com/docs/learn/advanced/known_limitations#large-datasets-and-internal-errors
// Use ulimit or a similar tool to increase resource consumption limits before running Meilisearch. For example, call ulimit -Sn 3000 in a UNIX environment to raise the number of allowed open file descriptors to 3000.
//
// Download: https://www.meilisearch.com/docs/learn/update_and_migration/updating#install-the-desired-version-of-meilisearch
// curl -L https://install.meilisearch.com | sh
// chmod +x meilisearch
// https://www.meilisearch.com/docs/guides/running_production#step-1%3A-install-meilisearch
// mv meilisearch /usr/local/bin/meilisearch
//
// SIDE NOTES:
// For https://www.meilisearch.com/docs/learn/update_and_migration/updating#dumpless-upgrade
// Download new version as as above, moving the executable to /usr/local/bin ($ mv meilisearch /usr/local/bin/meilisearch)
// Then restart the service (systemctl restart meilisearch) - see below for service setup
// However, the v1.30.1 is the last version supporting S3-streaming snapshots without
// an Enterprise Edition license as seen here: https://github.com/meilisearch/meilisearch/releases/tag/v1.31.0
// For classic upgrade using a dump, see https://www.meilisearch.com/docs/learn/update_and_migration/updating#using-a-dump
// and run the following commands:
// await mdb.createDump()
// sudo systemctl stop meilisearch
// - Below cmd removes data folder content including sub folders
// sudo find /var/lib/meilisearch/data -mindepth 1 -delete
// sudo -u meilisearch /usr/local/bin/meilisearch \
//   --config-file-path /etc/meilisearch.toml \
//   --import-dump /var/lib/meilisearch/dumps/20260223-042333276.dump
// ctrl + c
// sudo systemctl start meilisearch
//
// Now add a user to run Meilisearch, a non-login one
// useradd -d /var/lib/meilisearch -s /bin/false -m -r meilisearch
// chown meilisearch:meilisearch /usr/local/bin/meilisearch
//
// mkdir /var/lib/meilisearch/data /var/lib/meilisearch/dumps /var/lib/meilisearch/snapshots
// chown -R meilisearch:meilisearch /var/lib/meilisearch
// chmod 750 /var/lib/meilisearch
//
// sudo bash -c 'curl https://raw.githubusercontent.com/meilisearch/meilisearch/latest/config.toml > /etc/meilisearch.toml'
//
// env = "production"
// master_key = "MASTER_KEY"
// db_path = "/var/lib/meilisearch/data"
// dump_dir = "/var/lib/meilisearch/dumps"
// snapshot_dir = "/var/lib/meilisearch/snapshots"
//
// 🔬 [Experimental]: Upload snapshot tarballs to S3 by @Kerollmops in #5948
// Add the ability to upload snapshots directly to S3. Add below to .toml config file:
// s3_bucket_url = "https://s3.us-east-1.amazonaws.com"
// s3_bucket_region = "us-east-1"
// s3_bucket_name = "xxx-production"
// s3_snapshot_prefix = "meilisearch-snapshots/"
// s3_access_key = ""
// s3_secret_key = ""
// schedule_snapshot = 3600
//
// Run as a service: https://www.meilisearch.com/docs/guides/running_production#4-1-create-a-service-file
// sudo bash -c 'cat << EOF > /etc/systemd/system/meilisearch.service
// [Unit]
// Description=Meilisearch
// After=systemd-user-sessions.service

// [Service]
// Type=simple
// WorkingDirectory=/var/lib/meilisearch
// ExecStart=/usr/local/bin/meilisearch --config-file-path /etc/meilisearch.toml
// User=meilisearch
// Group=meilisearch
// Restart=on-failure

// [Install]
// WantedBy=multi-user.target
// EOF'
//
// systemctl enable meilisearch <- run at every boot
// systemctl start meilisearch <- start service now
// systemctl status meilisearch <- check status
// journalctl -u meilisearch -f <- follow logs
//
// $ meilisearch --<flags>...
// we wouldn't use a key (local access) but migration script currently needs it - https://github.com/meilisearch/meilisearch-migration/issues/44
// --master-key="meilisearchmasterkey"
// https://www.meilisearch.com/docs/learn/data_backup/snapshots
// --schedule_snapshot = 3600 // every hour, like a fast dump but work only on specific db version, not for upgrades
// https://github.com/meilisearch/meilisearch-migration?tab=readme-ov-file#2-correct-datams-path
// --db-path /var/lib/meilisearch/data
// https://www.meilisearch.com/docs/learn/update_and_migration/updating#create-the-dump
// --dump-dir /var/opt/meilisearch/dumps
import { MeiliSearch } from 'meilisearch'
import eventSchema from '#models/event/schema.js'
import jobSchema from '#models/job/schema.js'
import storedEventOwnerSchema from '#models/stored-event-owner/schema.js'
import pendingOpSchema from '#models/pending-op/schema.js'
import requestedPubkeySchema from '#models/requested-pubkey/schema.js'
import popularPubkeySchema from '#models/popular-pubkey/schema.js'
import ipActivitySchema from '#models/ip-activity/schema.js'
import maintenanceStateSchema from '#models/maintenance-state/schema.js'
import hashtagStatsSchema from '#models/hashtag-stats/schema.js'
import { addToCleanup } from '#helpers/process.js'

// Remember if deleting by filter, that filtering by <primaryKey> = xyz
// would match XyZ xyZ too cause it is case-insensitive on strings
//
// const timestamp = Math.floor(timestampInMilliseconds / 1000) // UNIX timestamps must be in seconds!! -> No longer the case
async function init () {
  let config = {
    host: process.env.MDB_HOST || 'http://127.0.0.1:7700',
    apiKey: process.env.MDB_API_KEY || 'meilisearchmasterkey' // no underline https://github.com/meilisearch/meilisearch-migration/issues/47
  }

  // Only start container if we are in test/dev AND no host is explicitly provided
  if ((process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') && !process.env.MDB_HOST) {
    try {
      const { GenericContainer, Wait } = await import('testcontainers')

      // Set Docker Host for Podman
      if (!process.env.DOCKER_HOST) {
        const uid = process.getuid ? process.getuid() : 1000
        process.env.DOCKER_HOST = `unix:///run/user/${uid}/podman/podman.sock`
      }

      console.log('Starting Meilisearch Container...')
      const container = await new GenericContainer('getmeili/meilisearch:v1.35.1')
        .withExposedPorts(7700)
        .withEnvironment({
          MEILI_NO_ANALYTICS: 'true'
        })
        .withWaitStrategy(Wait.forHttp('/health', 7700).withStartupTimeout(40000))
        .start()

      addToCleanup(async () => {
        console.log('Stopping Meilisearch Container...')
        await container.stop()
      })

      const containerHost = `http://${container.getHost()}:${container.getMappedPort(7700)}`
      const containerKey = 'masterKey'

      console.log(`Meilisearch Container started at ${containerHost}`)

      // Update config
      config = {
        host: containerHost,
        apiKey: containerKey
      }

      // Set env vars so re-imports (e.g. from mocks) find this running instance
      process.env.MDB_HOST = containerHost
      process.env.MDB_API_KEY = containerKey
    } catch (e) {
      console.error('Failed to start Meilisearch container:', e)
    }
  }

  let db = new MeiliSearch(config)

  // Enable experimental features
  const features = await db.getExperimentalFeatures()
  if (features.editDocumentsByFunction === false) { // it may not have this field
    if (process.env.NODE_ENV !== 'test') console.log('Enabling experimental editDocumentsByFunction feature...')
    await db.updateExperimentalFeatures({
      editDocumentsByFunction: true
    })
  }

  const constants = {
    maxTotalHits: 1000, // https://www.meilisearch.com/docs/learn/advanced/known_limitations#maximum-number-of-results-per-search
    maxBigIndexes: 20, // https://www.meilisearch.com/docs/learn/advanced/known_limitations#maximum-number-of-indexes-in-an-instance
    maxSearchTerms: 100 // https://www.meilisearch.com/docs/learn/advanced/known_limitations#maximum-number-of-query-words
  }
  // https://stackoverflow.com/a/50322882
  // Use this to escape chars when filtering like `attr = ${db.toMeiliValue(val))}`
  const toMeiliValue = v => typeof v === 'number' ? String(v) : '"' + String(v).replace(/(\\)|(")/g, (_m, p1, p2) => (p1 && '\\\\') || (p2 && '\\"')) + '"'

  // Make methods that return task metadata promise such as db.createIndex() return the task promise
  // Also memo db.index(uid) calls (note it is not the same as .getIndex, which just get index metadata)
  db = Object.assign(createAutoWaitProxy(db, true), { constants, toMeiliValue })

  const taskWaitTimeout = process.env.MDB_TASK_TIMEOUT ? parseInt(process.env.MDB_TASK_TIMEOUT) : 60000
  const taskWaitInterval = process.env.NODE_ENV === 'test' ? 20 : 50
  function createAutoWaitProxy (target, useCache = false) {
    const cache = useCache ? new Map() : null

    return new Proxy(target, {
      // receiver: the "this" of methods/getters/setters, usually is the proxy unless you call
      // manually with Reflect.get(target, prop, { foo: 'bar' } /* other obj */)
      // While the default behavior is return Reflect.get(...arguments)
      // it won't have access to target's private properties such as #example
      // so prefer returning target[prop] instead (when getter/setter)
      // or function (...args) { return target[prop].apply(that, args) } when target[prop] instanceof Function
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy#no_private_property_forwarding
      get: (target, prop, _receiver) => {
        const val = target[prop]
        if (typeof val !== 'function') return val

        return function (...args) {
          if (useCache && prop === 'index') {
            const cacheKey = JSON.stringify(args)
            if (cache.has(cacheKey)) return cache.get(cacheKey)
          }

          const ret = val.apply(target, args)

          if (prop === 'index') {
            const wrapped = createAutoWaitProxy(ret)
            if (useCache) {
              const cacheKey = JSON.stringify(args)
              cache.set(cacheKey, wrapped)
            }
            return wrapped
          }

          if (ret && typeof ret.then === 'function') {
            return ret.then(v => {
              if (v && typeof v === 'object' && 'taskUid' in v) {
                const waitFn = (typeof target.waitForTask === 'function')
                  ? target.waitForTask.bind(target)
                  : (target.tasks && typeof target.tasks.waitForTask === 'function')
                      ? target.tasks.waitForTask.bind(target.tasks)
                      : null

                if (!waitFn) {
                  console.warn('Could not find waitForTask method on target', target)
                  return v
                }

                return waitFn(v.taskUid, { timeout: taskWaitTimeout, interval: taskWaitInterval }).then(task => {
                  if (task.status !== 'succeeded') {
                    throw new Error(`Task ${task.status}: ${JSON.stringify(task.error ?? task.canceledBy)}`)
                  }
                  return task
                })
              }
              return v
            })
          }

          return ret
        }
      }
    })
  }

  process.env.MDB_DEBUG ??= process.env.NODE_ENV === 'production'
  function log (...args) {
    if (process.env.MDB_DEBUG === 'false') return
    console.log('[MDB DEBUG]', ...args)
  }
  await migrate(db, log)
  return db
}

const db = await init()
export default db

export async function migrate (db, log = console.log) {
  log('Running migration...')
  const idxs = [
    eventSchema,
    jobSchema,
    storedEventOwnerSchema,
    pendingOpSchema,
    requestedPubkeySchema,
    popularPubkeySchema,
    ipActivitySchema,
    maintenanceStateSchema,
    hashtagStatsSchema
  ]
  const idxsByUid = idxs.reduce((r, v) => ({ ...r, [v.uid]: v }), {})
  const currentIdxsByUid = await db.getIndexes({ limit: db.constants.maxBigIndexes })
    .then(({ results }) => results.reduce((r, { uid, primaryKey }) => ({ ...r, [uid]: { uid, primaryKey } }), {}))

  for (const { uid, primaryKey, settings } of idxs) {
    const currentIdx = currentIdxsByUid[uid]
    if (!currentIdx) {
      log(`${uid} index doesn't exist. Creating...`)
      try {
        await db.createIndex(uid, { primaryKey })
        log('Done creating')
      } catch (e) {
        if (e.code === 'index_already_exists' || (e.message && e.message.includes('index_already_exists'))) {
          log(`${uid} index created by another process. Skipping creation.`)
        } else {
          throw e
        }
      }
    } else if (currentIdx.primaryKey !== primaryKey) {
      log(`${uid} index had diverging primaryKey. Updating...`)
      db.updateIndex(uid, { primaryKey })
      log('Done updating primaryKey')
    }

    async function updateDivergingSettings () {
      const currentIdxSettings = await db.index(uid).getSettings()
      let hasAnyDiverged = false
      // We will consider just array values for now, cause we haven't set settings fields whose values are objects or strings
      // see models/<name>/schema.js > .settings
      for (const [key, valueArr] of Object.entries(settings)) {
        let hasDiverged = false
        const currentArr = currentIdxSettings[key] || []

        // Order-sensitive keys: rankingRules, searchableAttributes.
        // Order-insensitive keys: filterableAttributes, sortableAttributes, displayedAttributes, stopWords.
        if (['filterableAttributes', 'sortableAttributes', 'displayedAttributes', 'stopWords'].includes(key)) {
          const sortedValue = [...valueArr].sort()
          const sortedCurrent = [...currentArr].sort()
          hasDiverged = sortedValue.length !== sortedCurrent.length || sortedValue.some((v, i) => v !== sortedCurrent[i])
        } else {
          // Known Limitation: Meilisearch may return ['*'] for searchableAttributes even if set to [primaryKey]
          if (key === 'searchableAttributes' &&
                currentArr.length === 1 && currentArr[0] === '*' &&
                valueArr.length === 1 && valueArr[0] === primaryKey) {
            hasDiverged = false
          } else {
            hasDiverged = valueArr.length !== currentArr.length || valueArr.some((v, i) => v !== currentArr[i])
          }
        }

        if (hasDiverged) {
          log(`${uid} index had diverging ${key} setting. Updating...`)
          hasAnyDiverged = true
          await db.index(uid)[`update${key[0].toUpperCase()}${key.slice(1)}`](valueArr)
          log(`Done updating ${key} setting`)
        }
      }
      return hasAnyDiverged
    }
    const hadDivergedSettings = await updateDivergingSettings()
    if (hadDivergedSettings) log('Done updating diverging settings')
  }

  const leftoverIdxs = Object.keys(currentIdxsByUid).filter(uid => !idxsByUid[uid]).join(', ')
  if (leftoverIdxs) log(`Consider deleting these leftover indexes: ${leftoverIdxs}`)
  log('Migration done')
}
