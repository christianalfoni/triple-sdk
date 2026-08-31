# Migration — schemas change, clients are stale, nothing corrupts

The problem migrations actually have: old CODE keeps running — tabs stay open
for days, offline devices return weeks later. The design accepts this and makes
staleness safe rather than pretending it away.

## The generation is a hash

Client and server each compute a fingerprint of the schema SHAPE they were
built with (entity names, fields, types, cardinality, optionality, ref
targets). Every request and the `hello` handshake carry it. No registry, no
version numbers to bump — the code IS the version.

## The freeze, and the window

A server accepts its own generation plus an explicit allow-list:

```ts
new TripleServer({ schema, policy, compatibleSchemas: [PRE_EXPAND_HASH] })
```

A client whose generation is not accepted **freezes**: reads and writes throw,
live queries flip to `status: "outdated"`, the UI says "refresh". Deliberate:
a stale client that keeps writing is how data corrupts. The allow-list is the
migration window — the expand phase lists the previous hash so deployed clients
keep working; the contract phase drops it, freezing the stragglers, and the
operator decides when (the deploy knows what broke; this is where they say so).

## The doctrine: accrete, never break

1. **Expand** — new fields arrive `.optional()`; old clients simply never write
   them. Hash changes, previous hash goes in `compatibleSchemas`.
2. **Backfill** — a migration actor writes through `server.commit()`, riding the
   same log as everything else: connected clients receive the backfill LIVE as
   ordinary deltas. Migrations are not downtime; they are writes.
3. **Contract** — when old clients are gone, drop the compat hash, flip fields
   required, delete dead ones.

Retyping a field uses `Schema.union(Schema.string(), Schema.number())` as the
transitional type: every reader is FORCED by the type system to handle both
while the backfill runs, then the union narrows back.

## What happens to work in flight

An offline outbox written under the old generation is not discarded on deploy:
entries whose intent still compiles under the new schema **carry over**; the
rest surface through `onRejected`. And policy-only deploys — same shapes, new
rules — are covered by the **epoch** instead: new epoch, clients drop cache and
re-query ([recovery](./recovery.md)).

Deep dive: SPEC §4.5, §7.3.
