# Realtime — one stream, filtered per reader

Every client holds one Server-Sent Events stream. Everything live arrives on it,
in one envelope family: `hello`, `delta`, `repair`, `resync`, `presence`,
`ephemeral`.

## The order of a stream

`hello` is ALWAYS first — epoch, current version, schema generation, accepted
generations. Nothing else on the stream is interpretable until both sides agree
what history and what schema they are speaking ([recovery](./recovery.md)).
Then the presence roster, then backlog (if a cursor was presented), then live.

## Fan-out, per subscriber

When a write commits, every subscriber receives the delta **filtered for their
eyes** — removals against the pre-state (you must have been able to see what
disappears), additions against the post-state. The write path stays cheap
because the work is shared: the per-subject triple diffs are computed once, the
policy verdicts are memoized per actor, and only then does each subscriber get
their slice. Measured: 0.1ms to fan one write to 500 subscribers; ~5,000
writes/s sustained at 500 subscribers.

**Permission changes are fan-out too** (§10.6). Policies declare their `fields`,
so the server statically knows which writes change whose visibility. Removing
you from a team synthesizes REMOVE deltas for every todo you just lost — to
you; your teammates see only the membership change. A revocation touching a
500-todo team reaches 500 subscribers in ~22ms. Visibility moves at the speed
of data because it IS data.

## Acks are the echo, versions are the dedupe

Your own write comes back as an `ack` carrying the server-compiled delta; other
clients get it as a push. Both carry the version number, and the client's
cursor makes redelivery idempotent: anything at or below the cursor is skipped.
There is no "exactly once" machinery — just one number ([recovery](./recovery.md)).

## Ephemeral — the second lane

Not everything belongs in history. `client.broadcast(payload, { about? })`
rides the same stream but never touches the log:

- capped at 16KB, coalesced ~33ms per key — 60 cursor frames a second reach
  peers as ~30 messages and ZERO log entries;
- `about: subjectId` scopes delivery by visibility: only peers who may SEE that
  subject receive the broadcast (`canSeeSubject`, §13).

Durable facts ride the log; transient state rides broadcast. The moment a drag
settles, ONE transact records where it landed.

## Backpressure

A subscriber that cannot keep up is disconnected (buffer past 1MB), not
buffered forever — it reconnects with its cursor and the log heals it. Slow
consumers cost themselves, never the workspace.

Deep dive: SPEC §7.7, §10.6, §13.
