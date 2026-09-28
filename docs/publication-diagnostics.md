# Diagnosing slow publication acknowledgements

The relay emits one `[relay-publication] ` line followed by compact JSON when
an EVENT handler takes at least 3000 ms. PM2 captures it in the existing stdout
logs, so the existing PM2 log rotation/retention also covers these diagnostics.
No additional continuously growing log file is created.

Deploy the updated relay checkout and reload the `web.social-server` processes
using the existing deployment procedure. The default threshold needs no
`ecosystem.config.cjs` changes. `RELAY_PUBLICATION_SLOW_MS` can override it in
the server environment; `0` logs every completed publication and is intended
for tests or short diagnostic sessions. Invalid values fall back to 3000 ms.

## Collect over SSH

Use the same Unix user and `PM2_HOME` that own the running server. From the
**44b-relay checkout** on the server:

```sh
cd ~/repositories/44b-relay
npm run publication:diagnose -- --since=30m
```

The command discovers both `web.social-server` cluster instances through
`pm2 jlist`, reads their stdout/stderr paths and matching retained rotations
(including `.gz`), filters by the record's completion time and prints a short
summary. It does not restart the server, connect to Meilisearch, or modify logs.
The archive contains only allowlisted diagnostic fields, never the PM2 process
environment or ordinary console output.

The output is always `/tmp/relay-diagnostic.json.gz` by default. Repeated runs
**replace this same file**, without timestamped archives. A fixed
`/tmp/relay-diagnostic.json.gz.tmp` staging file is exclusively created, synced,
and atomically renamed over the old archive. A concurrent collector fails
instead of overwriting that staging file. A fatal collection/write failure preserves
the previous archive and normal failures clean up staging. Partial collections
with warnings still produce a new archive. If the collector
is forcibly killed, the single staging file can remain: after confirming no
collector is running, remove that `.tmp` file and rerun. Output permissions
are `0600`.

Download from a **local terminal**, outside the SSH session:

```sh
scp usuario@servidor:/tmp/relay-diagnostic.json.gz .
```

The local destination also has a fixed name and is overwritten on subsequent
copies. SSH/tmux scrollback and manual text selection are unnecessary.

Optional arguments (the same output path is reused unless explicitly changed):

```sh
npm run publication:diagnose -- --since=2h
npm run publication:diagnose -- --app=web.social-server --output=/tmp/relay-diagnostic.json.gz
npm run publication:diagnose -- --help
```

## Reading the report

- `elapsedMs`: handler entry through completion of its response send call.
- `stages`: validation, metadata, IPC readiness, persistence, broadcast and
  `sendOk`. `sendOk` measures the server's call to `ws.send`, not delivery to
  the remote client. Binary validation/restriction checks and miscellaneous
  handler overhead are included in total time but may be outside named stages.
- `database`: index, method, success and elapsed time for database calls made
  in that publication context. Write durations include the existing task wait.
- `tasks`: task and batch IDs, index/type/status, original Meilisearch timestamps,
  queue time (`startedAt - enqueuedAt`), execution time
  (`finishedAt - startedAt`), local task-wait time and communication failure
  count. Missing server timestamps produce `null`, not invented durations.
- `accepted`: the boolean used for the OK response; it does not prove the
  remote client received it. `null` means no response outcome was recorded.
- `pid`, `instance`, event ID and UTC timestamps permit correlation across
  cluster workers and client observations. Content, tags, author keys, IPs,
  database query arguments and error messages are excluded.

Persistence, database calls and task waits are **nested measurements**, not
separate costs to sum. The collector summarizes only retained slow records;
it does not estimate overall throughput or latency percentiles. A large task
queue time suggests competing writes; a large execution time suggests expensive
processing. The relay still awaits successful persistence and broadcast before
OK, exactly as before. Instrumentation introduces no extra database queries.

Task IDs from the report can be inspected with the existing read-only tool:

```sh
NODE_ENV=production npm run mdb:diagnose -- --task=123
```

Use the deployment's usual database environment. Task history may already have
been pruned; the report keeps timing fields even if those tasks disappear.

## Bounds and limitations

The collector accepts a window up to seven days and scans up to 512 candidate
files and 256 MiB of decompressed log data, at most 32 MiB per file. Large
plain logs are read from their tail so recent entries are preferred; gzip
rotations are streamed from the beginning. Partial reads are reported. It exports up to 2000 unique records;
lines over 64 KiB are skipped. Per-publication database/task details are capped
at 32 each, with omitted counts. Warnings identify malformed/truncated files
and collection limits. Missing logs, expired rotations or publications still
in progress cannot be recovered. No records is not proof that no slowdown
occurred. Collect soon after a reproduction and keep the `warnings` field when
sharing the report.
