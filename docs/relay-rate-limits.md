# Relay work admission

Global Nostr messages share a token bucket per authenticated pubkey, otherwise
per IP: capacity 120 messages, refilling 60 tokens/second (full in two seconds).
Connections/devices on the same anonymous IP share this allowance. Rejected
messages do not create debt. Idle buckets expire after their refill period.
AUTH, event-kind, connection and subscription limits remain unchanged.

This continuous refill agrees with the launcher pool's model. The launcher
shares a smaller 60-message burst / 30-per-second budget across sockets to the
same host, leaving room for two such clients behind one IP. More clients or
other traffic can still legitimately reach the server's limit.

CLOSE is exempt from work admission: it only releases a subscription, including
its cleanup timer. Its shape must still be exactly ["CLOSE", string]. This also
applies to unknown subscription IDs; they never allocate a subscription.

Rate-limited CLOSED and rejected OK retain optional `retry_after` seconds,
rounded up and at least one second. Clients should defer new work for that
period without deferring cleanup, and retain failed operations for their normal
retry policy. These changes require deployment of the relay to affect the
public endpoint; changing client code alone does not raise server limits.
