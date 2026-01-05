// https://www.meilisearch.com/docs/learn/advanced/known_limitations#large-datasets-and-internal-errors
// Use ulimit or a similar tool to increase resource consumption limits before running Meilisearch. For example, call ulimit -Sn 3000 in a UNIX environment to raise the number of allowed open file descriptors to 3000.
//
// Download: https://www.meilisearch.com/docs/learn/update_and_migration/updating#install-the-desired-version-of-meilisearch
// curl -L https://install.meilisearch.com | sh
// chmod +x meilisearch
// https://www.meilisearch.com/docs/guides/running_production#step-1%3A-install-meilisearch
// mv meilisearch /usr/local/bin/meilisearch
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
import eventSchema from '../models/event/schema'
import { typeof2 } from '../helpers/operator'

// Remember if deleting by filter, that filtering by <primaryKey> = xyz
// would match XyZ xyZ too cause it is case-insensitive on strings
//
// const timestamp = Math.floor(timestampInMilliseconds / 1000) // UNIX timestamps must be in seconds!!
async function init () {
  const config = {
    host: 'http://127.0.0.1:7700',
    apiKey: 'meilisearchmasterkey' // no underline https://github.com/meilisearch/meilisearch-migration/issues/47
  }
  let db = new MeiliSearch(config)
  const constants = {
    maxTotalHits: 1000, // https://www.meilisearch.com/docs/learn/advanced/known_limitations#maximum-number-of-results-per-search
    maxBigIndexes: 20, // https://www.meilisearch.com/docs/learn/advanced/known_limitations#maximum-number-of-indexes-in-an-instance
    maxSearchTerms: 100 // https://www.meilisearch.com/docs/learn/advanced/known_limitations#maximum-number-of-query-words
  }
  // https://stackoverflow.com/a/50322882
  // Use this to escape chars when filtering like `attr = ${db.toMeiliValue(val))}`
  const toMeiliValue = v => '"' + String(v).replace(/(\\)|(")/g, (_m, p1, p2) => (p1 && '\\\\') || (p2 && '\\"')) + '"'
  const cache = new Map()
  // Make methods that return task metadata promise such as db.createIndex() return the task promise
  // Also memo db.index(uid) calls (note it is not the same as .getIndex, which just get index metadata)
  db = new Proxy(Object.assign(db, { constants, toMeiliValue }), {
    // receiver: the "this" of methods/getters/setters, usually is the proxy unless you call
    // manually with Reflect.get(target, prop, { foo: 'bar' } /* other obj */)
    // While the default behavior is return Reflect.get(...arguments)
    // it won't have access to target's private properties such as #example
    // so prefer returning target[prop] instead (when getter/setter)
    // or function (...args) { return target[prop].apply(that, args) } when target[prop] instanceof Function
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy#no_private_property_forwarding
    get: (target, prop, receiver) => {
      if (!(target[prop] instanceof Function)) return target[prop]

      if (typeof2(target[prop]) === 'asyncfunction') {
        return async function (...args) {
          const that = this === receiver ? target : this
          return target[prop].apply(that, args)
            .then(v => 'taskUid' in v
              ? that.waitForTask(v.taskUid).then(v => {
                if (v.status !== 'succeeded') throw new Error(`Task ${v.status}: ${JSON.stringify(v.error ?? v.canceledBy)}`)
                return v
              })
              : v)
        }
      }

      return function (...args) {
        let cacheKey
        // cache just the index method
        if (prop === 'index' && this === receiver) {
          cacheKey = `${prop}:${JSON.stringify(args)}`
          if (cache.has(cacheKey)) return cache.get(cacheKey)
        }
        const ret = target[prop].apply(this === receiver ? target : this, args)
        if (cacheKey) cache.set(cacheKey, ret)
        return ret
      }
    }
  })
  await migrate(db)
  return db
}

const db = await init()
export default db

async function migrate (db) {
  console.log('Running migration...')
  const idxs = [
    eventSchema
  ]
  const idxsByUid = idxs.reduce((r, v) => ({ ...r, [v.uid]: v }), {})
  const currentIdxsByUid = await db.getIndexes({ limit: db.constants.maxBigIndexes })
    .then(({ results }) => results.reduce((r, { uid, primaryKey }) => ({ ...r, [uid]: { uid, primaryKey } }), {}))

  for (const { uid, primaryKey, settings } of idxs) {
    const currentIdx = currentIdxsByUid[uid]
    if (!currentIdx) {
      console.log(`${uid} index doesn't exit. Creating...`)
      await db.createIndex(uid, { primaryKey })
      await db.index(uid).updateSettings(settings) // this won't touch unset default values
      console.log('Done creating')
    } else {
      if (currentIdx.primaryKey !== primaryKey) {
        console.log(`${uid} index had diverging primaryKey. Updating...`)
        db.updateIndex(uid, { primaryKey })
        console.log('Done updating primaryKey')
      }
      async function updateDivergingSettings () {
        const currentIdxSettings = await db.index(uid).getSettings()
        // will consider just array values for now, cause we haven't set settings fields whose values are objects or strings
        // see models/<name>/schema.js > .settings
        for (const [key, valueArr] of Object.entries(settings)) {
          if (valueArr.some((v, i) => !currentIdxSettings[key] || currentIdxSettings[key][i] !== v)) {
            console.log(`${uid} index had diverging ${key} setting. Updating...`)
            await db.index(uid)[`update${key[0].toUpperCase()}${key.slice(1)}`](valueArr)
            console.log(`Done updating ${key} setting`)
          }
        }
        return false
      }
      await updateDivergingSettings()
      console.log('Done updating diverging settings')
    }
  }

  const leftoverIdxs = Object.keys(currentIdxsByUid).filter(uid => !idxsByUid[uid]).join(', ')
  if (leftoverIdxs) console.log(`Consider deleting these leftover indexes: ${leftoverIdxs}`)
  console.log('Migration done')
}
