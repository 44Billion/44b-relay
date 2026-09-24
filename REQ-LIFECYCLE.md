# Stored-event reads and EOSE

A successful REQ history read sends matching EVENT messages followed by EOSE,
including a genuinely empty result. MDB/DAO failures propagate through the
fetcher. The REQ handler logs the original server error and sends:

```json
["CLOSED", "subscription-id", "error: failed to read stored events"]
```

It removes that subscription and does not send EOSE or continue live delivery.
Events already delivered before a later filter fails cannot be recalled; clients
must not treat such a partial read as completed coverage. Database details are
not included in the CLOSED reason.

Each REQ replacement has its own object identity, including requests received
within the same millisecond. Late results or errors from an older request cannot
send EOSE/CLOSED or remove its replacement. Closing a request likewise prevents
late history from being delivered.

The independent regression tests can run without a database container:

```sh
NODE_ENV=test node --test --experimental-test-module-mocks tests/services/relay/nostr-message-handler/req-read-failure.test.js
```
