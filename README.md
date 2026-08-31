# Triple SDK

A local-first realtime sync SDK built on RDF-style triples, written to be read.
Zero runtime dependencies — plain `node:http`, `node:sqlite`, and Server-Sent Events.

The idea in five lines:

1. Every fact is a triple `[subject, predicate, object]`; every change is a delta `{added, removed}` — there is no update.
2. The **log** is the truth (append-only, versioned); the **store** is a fold of it. One adapter owns both, atomically.
3. The **query** is the unit of everything: what syncs, what you read, what notifies you.
4. **Schema is shared shape; policy is server-only logic** — the file boundary is the trust boundary.
5. Writes are **optimistic layers** over confirmed state; ack or reject just drops a layer.

## One query, end to end

The fastest way to understand the system: follow one query down to the store and
back, watching the data change costume. The dataset is the demo seed (ids
shortened); the actor is Christian; the query is chosen so the policy moment is
visible:

```
STORE (4 todos):  todo_1 "Understand…"   owner→christian
                  todo_2 "Build…"        owner→christian
                  todo_3 "Decide…"       owner→ada, team→platform   (christian is a member)
                  todo_4 "Ada's private" owner→ada                   (no team!)
```

```ts
Query.from(Todo)
  .where("owner", [{ id: "user_christian" }, { id: "user_ada" }]) // set form: IN
  .select({ text: true, owner: { name: true } });
```

### Down

1. **Builder → `toPayload`** — records-language becomes facts-language (fields → predicates):
   ```json
   { "constraints": [{ "predicate": "todo/owner",
                       "anyOf": [{ "id": "user_christian" }, { "id": "user_ada" }] }],
     "selection":   { "todo/text": true, "todo/owner": { "user/name": true } } }
   ```
   > ✓ the wire is inspectable data, not code · ✗ predicates repeat per fact — verbose next to SQL
2. **`HttpTransport`** — `POST /api/query` wraps it: `{ kind: "query", schema: "ebfc1c47", payload }`. The hash is the client's schema generation.
3. **Server edge** — `resolveActor(request)` → `"user_christian"`. Identity comes from the connection; the payload never says who is asking.
4. **Handshake** — the hash matches a generation the server accepts → proceed. (Otherwise: 409, the client freezes, no data moves — §7.3.)
   > ✓ staleness cannot be silent — types never lie about the wire · ✗ a hard freeze: old clients STOP unless the compat window lists them
5. **Seed via the POS index** — one jump per set-form value:
   ```
   POS["todo/owner"][→christian] = { todo_1, todo_2 }
   POS["todo/owner"][→ada]       = { todo_3, todo_4 }   → candidates: [t1, t2, t3, t4]
   ```
   > ✓ O(matches), two hops regardless of store size · ✗ no planner: YOU order constraints, and a bad order is slow with no safety net
6. **Policy, inside the scan** — each candidate's constraint triple through `canRead`
   (rule: mine, or my team's):
   ```
   [todo_1, todo/owner, →christian]   owner = me              ✓
   [todo_2, todo/owner, →christian]   owner = me              ✓
   [todo_3, todo/owner, →ada]         team→platform, member   ✓
   [todo_4, todo/owner, →ada]         owner ≠ me, no team     ✗ DROPPED → roots: [t1, t2, t3]
   ```
   > ✓ nothing leaks — not even through counts, joins or windows · ✗ a verdict per candidate: low-selectivity scans pay the policy bill (measured, §10.7)
7. **Level-order selection walk** — one batched read per (level × predicate), every triple re-passing `canRead`:
   ```
   level 0: todo/text over [t1,t2,t3] → 3 facts · refs in todo/owner → { christian, ada }
   level 1: user/name over [christian, ada] → 2 facts
   ```
8. **Adapter floor** — those reads are `Map` jumps (memory) or index seeks on
   `idx_po` (sqlite / Durable Objects), objects in the order-preserving encoding.
   > ✓ swap memory/sqlite/DO, identical semantics; sync reads = free snapshot isolation · ✗ the sync contract forbids network databases as the read path (§5.4 — settled, not accidental)

### Up

1. **The wire** — facts plus a place in time. **Eight triples, no rows** — and no
   trace of `todo_4`: absent, not redacted:
   ```json
   { "triples": [
       ["todo_1","todo/text","Understand…"], ["todo_2","todo/text","Build…"],
       ["todo_3","todo/text","Decide…"],
       ["todo_1","todo/owner",{"id":"user_christian"}],
       ["todo_2","todo/owner",{"id":"user_christian"}],
       ["todo_3","todo/owner",{"id":"user_ada"}],
       ["user_christian","user/name","Christian"], ["user_ada","user/name","Ada"] ],
     "version": 12 }
   ```
   > ✓ facts compose into ANY cache, dedupe by identity, diff cleanly · ✗ rows must be recomputed client-side; facts are chattier than rows
2. **`client.load`** — the snapshot-meets-cursor check: response version 12 vs the
   live stream's cursor. A stale answer can never resurrect a removal the stream
   already delivered.
3. **`#confirmed.apply`** — the client's own store (same `Store` class as the
   server's) folds the facts in; SPO/POS indexes update incrementally.
4. **The executor runs AGAIN, locally** — same `resolveRoots` over the cache plus
   any pending optimistic layers → `[t1, t2, t3]`. `todo_4` is not in the cache,
   so the client cannot even ask the question it is not allowed to answer.
   > ✓ offline reads, optimistic overlays and live updates all fall out of ONE mechanism · ✗ CPU spent twice, and both sides' executors must agree exactly (pinned by the smoke suite)
5. **`materialize`** — per root, through the selection: predicates bared, refs
   traversed, cardinality applied:
   ```json
   { "id": "todo_1", "text": "Understand…",
     "owner": { "id": "user_christian", "name": "Christian" } }
   ```
6. **`LiveQuery` / `useQuery`** — three rows fingerprinted, `data` swaps,
   `status: "ready"`. When Ada later renames `todo_3`, a one-fact delta arrives,
   intersects this query's predicate set, and only steps 3–6 replay — with
   `todo_1` and `todo_2` keeping `===`.

**The manifest: a shape went down; eight facts came up; three records were built
at home.** The server ran the query to decide what to SEND; the client ran the
same query to decide what to SHOW.

## One mutation, end to end

Same dataset. Christian — NOT the owner, but a team member — toggles `completed`
on Ada's team todo. Chosen so the per-field override, the fan-out, and every
recovery branch show up:

```ts
await client.transact((tx) => {
  tx.edit(Todo, "todo_3").completed = true; // a DRAFT: property write → intent
});
```

### Down

1. **`Transaction`** — record-phrased intent. It reads the LOCAL view (cache +
   pending) to build two artifacts:
   ```json
   {
     "operations": [
       { "op": "set", "subject": "todo_3", "predicate": "todo/completed", "value": true }
     ],
     "delta": {
       "removed": [["todo_3", "todo/completed", false]],
       "added":   [["todo_3", "todo/completed", true]]
     }
   }
   ```
   The `operations` are what TRAVELS; the `delta` is only this client's preview.
   > ✓ intent survives being days old — the server re-derives against truth · ✗ the vocabulary is four verbs (set/add/remove/delete): no server-computed increments, so counters are last-write-wins
2. **The pending layer** — the preview delta is pushed onto the stack; queries
   whose predicates intersect (`todo/completed`) rematerialize → **the checkbox
   flips before any network**. The promise is still unresolved.
   > ✓ 0ms UI and ZERO undo code — rollback is "drop a layer" · ✗ the preview guessed the remove-half from a partial cache; until the ack, it can differ from truth
3. **Serialized send** — one mutation in flight at a time:
   `{ kind: "transact", schema: "ebfc1c47", mutationId: "m17", operations }`.
   Offline? The intent lands in the durable **outbox** (`"queued"`), survives
   reloads, drains in order on reconnect.
   > ✓ order preserved, replay trivially safe · ✗ throughput per client = one round trip at a time (the outbox batches on drain)
4. **Server edge** — `resolveActor` → `"user_christian"`; schema handshake as
   before.
5. **`compileOperations`** — intent meets TRUTH: the server derives the
   authoritative remove-half from ITS state, in op order, each op seeing the
   last one's effect. The client's guess is discarded.
   > ✓ a partial cache can never corrupt the store · ✗ server CPU per op, and "ops see earlier ops" is semantics you must learn once
6. **`checkWrite`** — triples grouped BY SUBJECT (the record!), verb derived:
   `todo_3` existed before and after → `update`. Then per touched field:
   ```
   todo/completed → overrides.completed.write → team member? christian ∈ platform ✓ ALLOW
   (had he renamed todo/text → entity rule: owner-only → ada ≠ christian ✗ REJECT — all-or-nothing)
   ```
   > ✓ field-sized permissions on a record-sized verb, one entity-rule verdict shared · ✗ another verdict per overridden field touched
7. **Required-fields check (§4.5)** — no surviving subject may lose a required
   field; referential integrity included.
8. **`apply` — store and log, ONE transaction** → `LogEntry v13`. The fold
   invariant (`state === fold(log)`) is testable because this step is atomic.
   > ✓ history and state cannot disagree · ✗ the fsync sits in the write path (WAL; on Durable Objects the output gate hides it)

### Up

1. **Ack to Christian** — `{ kind: "ack", version: 13, delta: <authoritative> }`.
   The client absorbs the SERVER's delta into confirmed, **drops the pending
   layer**, advances the cursor to 13. The promise resolves `"committed"`
   (or `"queued"` if it went via the outbox).
   > ✓ reject is the same move — drop the layer, UI reverts, no code · ✗ per-field last-write-wins: two people editing the SAME field race; collaborative text needs a CRDT (ledgered out, §11)
2. **Push to Ada** — her stream carries the same delta, FILTERED FOR HER EYES
   (removals against pre-state, additions against post-state — she may read
   `todo_3`, so both pass): `{ kind: "delta", version: 13, actor: "user_christian" }`.
   The heavy lifting was shared: per-subject diffs computed once, verdicts
   memoized per actor (0.1ms to 500 subscribers).
   > ✓ per-reader privacy on every push · ✗ per-reader work — this stream can never be CDN-cached (the §10.7 fork)
3. **Ada's client** — `13 > cursor 12` → apply, predicate-intersect, her team
   query rematerializes; row identity keeps every other row `===`.
4. **The visibility branch (not taken here)** — had the write CHANGED who can
   see what (say, removing Ada from the team), the §10.6 dependency map would
   synthesize REMOVE deltas for the todos she just lost — permission change
   arriving as data.
5. **The recovery branches (when things are not this smooth):**
   - Ada was OFFLINE → reconnects `?since=12`, the log replays v13.
   - her cursor predates the compacted log → `resync`: drop cache, re-query.
   - the change revoked her access AND she missed it → `repair`: evict by id,
     refresh by value.
   - Christian's queued write finally rejected → surfaced via `onRejected`,
     never silently dropped.
   > ✓ every failure heals through ONE number (the cursor) plus two coarser identities (epoch, schema hash) · ✗ repair re-ships current triples for affected subjects — reconnects after policy churn cost bandwidth

**The manifest: one intent went down; one authoritative delta came back, wearing
two hats — an ack for its author, a push for everyone else — and every recovery
path is just a longer route to the same fold.**

## Why this design

Three commitments, each carried end to end through the flows above:

1. **Everything hard is one mechanism.** Realtime, optimistic writes, offline
   replay, catch-up, migration, audit — all of it is *fold an append-only log of
   deltas*. State = fold(log); behind = one number; rollback = drop a layer.
   There is no cache-invalidation story anywhere, because every layer is a
   derivation of the one to its left.
2. **Permissions are data flow, not a gate.** Policies filter inside the scan,
   so an invisible row is indistinguishable from an absent one — and a
   permission CHANGE arrives as a delta: live in ~22ms, after offline via
   `repair`. If your product has private rows inside shared spaces, this is the
   feature you would otherwise discover you needed a year in.
3. **The unit of everything is the workspace.** One cell = one process + one
   SQLite file ≈ 5,000 concurrent users — and a cell deploys unchanged as a
   Cloudflare Durable Object, where the single-writer rule and the durability
   window become platform guarantees and idle workspaces cost nothing.

|                           |                                                                    |                                                              |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Schema & entities**     | typed shape, shared by both sides; required by default             | `Schema.from` → `Schema.build`, `.optional()`, `.multiple()`, `Schema.object()` |
| **Typed queries**         | find + shape in one, result types computed                         | `.where()` (values or sets), `.whereNot/Absent/Greater/Lesser/Between`, `.whereEither()`, `.whereId()`, subqueries |
| **Ordered windows**       | pagination over a set: explicit order, keyset cursors, live refill | `.orderBy().limit().after()`                                 |
| **Live queries**          | the only read: data, status, per-query reactivity                  | `client.watch()`, `useQuery()`                               |
| **Permissions**           | entity verbs + declared fields, filtered inside the scan           | `Policy.from(Entity, rules)` per entity                      |
| **Realtime**              | SSE push, per-reader filtered; permission changes arrive as deltas | `client.connect()`                                           |
| **Optimistic writes**     | pending layer over confirmed; intent on the wire                   | `client.transact()` → `"committed" \| "queued"`              |
| **Offline**               | cache + write queue survive reloads; drains in order when healed   | `persistence`, `onRejected()`                                |
| **Presence**              | who's online — roster once, O(1) diffs                             | `client.presence`, `onPresence()`                            |
| **Multiplayer fast path** | ephemeral broadcasts: unlogged, coalesced, visibility-scoped       | `broadcast()`, `onEphemeral()`                               |
| **Migrations**            | accrete-never-break, compat windows, schema freeze                 | `compatibleSchemas`, `Schema.union()`                        |
| **Durability & cells**    | log+store in one SQLite transaction; a workspace per cell          | `SqliteStorage`, `createCellHost()`                          |

[`SPEC.md`](./SPEC.md) is the numbered contract every source file cites. §11 is the
ledger: everything deferred, cut, or known-imperfect, each with its revival trigger.

```bash
npm run dev          # demo at localhost:5173 — open TWO windows, they sync live
npm run smoke        # 20-step headless walkthrough of every invariant
npm run bench        # the measurements below, on your machine
npm run typecheck    # the type tests ARE tests
RDF_DB=.data/app.db npm run dev    # durable: survives restarts, clients replay the log
```

## Going deeper

Mechanism docs — one page each, mechanism first, API second:

| | | | |
|---|---|---|---|
| [Adapters](docs/adapters.md) | [Persistence](docs/persistence.md) | [Realtime](docs/realtime.md) | [Recovery](docs/recovery.md) |
| [Presence](docs/presence.md) | [Querying & performance](docs/querying.md) | [Migration](docs/migration.md) | [Permissions](docs/permissions.md) |
| [The worked example](docs/example.md) | [Architecture & adoption](docs/architecture.md) | [Measurements](docs/measurements.md) | [Comparisons](docs/comparisons.md) |

[`SPEC.md`](SPEC.md) is the numbered contract every page cites — including the
decisions made the expensive way (§10.7: the declarative-policy fork, built,
measured, removed; §5.4: why reads never go async). [`GOALS.md`](GOALS.md)
records the three measured burn-downs behind the numbers.

## Run it

```bash
npm run dev        # demo at localhost:5173 — open TWO windows, they sync live
npm run smoke      # 35 steps against a real server (memory or RDF_DB= sqlite)
npm run invariant  # state === fold(log), both adapters · policy · repair proofs
npm run bench      # the measurements
npm run typecheck  # the type-level tests — typecheck IS the test
npm run do:dev     # the same cell on Cloudflare's workerd (then do:smoke, do:bench)
```
