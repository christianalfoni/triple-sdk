# Adapters — one owner for store and log

Everything below the SDK is one interface: `StorageAdapter`. It owns **both** the
current state (the store) and its history (the append-only log), because a write
must land in both atomically — a store that says v42 while the log stops at v41
is corruption, not lag (SPEC §5).

```ts
interface StorageAdapter {
  readonly version: number;             // highest committed version — cheap, never derived
  readonly epoch?: number;              // this history's identity (§7.3)
  match(pattern): Triple[];             // read the store
  apply(delta, actor): LogEntry | null; // commit: store + log, one transaction
  entriesSince(since): LogEntry[] | null; // catch-up; null = "before my retention floor"
  snapshot(): { version, triples };
  compact?(upTo): void;                 // forget history at/below upTo (§7.3)
  // fast paths — optional, callers fall back gracefully:
  matchSubjects?(subjects, predicate);  // one batched read instead of N (§11.4)
  topSubjects?(subjects, predicate, direction, take, after?); // ranked windows (§6.6)
  matchRange?(predicate, encodedBounds); // index range reads for whereGreater/Between (§6.9)
}
```

The contract that makes the rest of the system honest:

- **`apply` is atomic across store and log.** SqliteStorage wraps both tables in
  one SQL transaction; MemoryStorage mutates both in one synchronous call.
- **`entriesSince` may refuse.** How much history to keep is the adapter's
  choice. A cursor from below the retention floor gets `null`, and the caller
  falls back to state: drop cache, re-query ([recovery](./recovery.md)).
- **The fast paths are the performance story.** Every optional method exists
  because a measurement demanded it: `matchSubjects` killed the N+1 (one
  `json_each` join instead of 500 statements), `topSubjects` ranks windows
  inside the index, `matchRange` turned a 57ms predicate scan into a 2ms index
  range read — possible because the `object` column stores the
  **order-preserving encoding** (§6.6): lexicographic order IS value order, for
  strings and numbers alike.

## The two adapters

**MemoryStorage** — Maps for SPO/POS indexes, an array for the log, a `floor`
for compaction. The reference implementation: every behavior is readable.

**SqliteStorage** (`node:sqlite`, zero dependencies) — three tables
(`triples`, `log`, `meta`), WAL mode, prepared statements, persisted epoch.
Batched reads use `json_each(?) AS j CROSS JOIN triples` — CROSS JOIN pins the
join order the planner otherwise inverts. Survives restart: boot reads the
tables, the log replays to any client that was away.

## Why reads are synchronous — and stay that way

A network database (Postgres) cannot implement this interface, and that is a
decision, not an accident (SPEC §5.4). Three costs stack up, and the third is
the quiet one:

1. **Async is viral** — every scan loop, the recursive materializer, the policy
   fields loader, every handler: ~1,400 lines of tight loops become
   await-chains. (The CLIENT is untouched either way — its store is a local Map;
   the question is server-side only.)
2. **Async alone does not buy a network database.** A query makes hundreds of
   ~1µs `match` calls; at 0.5ms network RTT that is 100–500ms per query unless
   every loop compiles into set-shaped reads — at which point you are not adding
   `await`, you are building a SQL compiler for queries AND policies. That is a
   real system: it is called Zero, or Electric, and it comes with their
   declarative-only constraints (§10.7).
3. **Sync reads give snapshot isolation for free.** One event loop, no awaits:
   nothing writes during a read — the policy cache's correctness literally
   depends on it. Async reads let writes interleave mid-query; honesty then
   demands versioned reads (MVCC) or query/write locking. This guarantee is
   invisible until it is gone.

So: the cells architecture (§12) guarantees a workspace fits one process, and
**reads come from memory (or sqlite, which is memory-speed); a network database
earns its keep as durability** — commit locally and synchronously, stream the
log outward with backpressure, fold it back at boot. Same conclusion Figma's
LiveGraph and Linear's sync engine reached. The genuine boundary: one workspace
larger than a machine's RAM — which is the point where you are building Zero,
and should probably use it.

## The platform that IS this design: Durable Objects

Cloudflare's SQLite-backed Durable Objects are this architecture as a managed
runtime, mapping almost line by line:

| this design | Durable Objects |
|---|---|
| sync adapter reads (§5.4) | `ctx.storage.sql.exec(...)` — synchronous, same-isolate SQLite |
| write-through durability, loss window noted | the **output gate**: messages leave only after writes are durable — the window closed by the platform, still without awaiting per write |
| "nothing writes during a read" (free snapshot isolation) | input gates keep the object single-threaded across awaits — runtime-enforced |
| a cell per workspace, single-writer invariant (§12) | one DO per `idFromName(workspaceId)` — uniqueness is the platform's guarantee, not your discipline |

Porting is three files, because the boundaries already sit right: a
`DurableObjectStorage` adapter (same SQL as `SqliteStorage`), a transport
binding (`TripleServer` is transport-agnostic; DO `fetch` + hibernating
WebSockets replace node SSE), and the platform's routing in place of
`createCellHost`. Executor, policy, log, recovery: untouched.

**This port exists and is measured.** `src/do/worker.ts` + `DurableStorage`
(`src/sdk/server/durable.ts`) + the fetch/SSE binding (`fetch.ts`) run the demo
cell on `workerd`: `npm run do:dev`, then the UNCHANGED 35-step smoke suite
passes against it (`npm run do:smoke`), and the same-harness bench
(`npm run do:bench` vs the node server) says the runtime factor is small once
storage is held equal — 20k todos, localhost HTTP, wrangler dev:

| | node + memory | node + sqlite | Durable Object (workerd) |
|---|---|---|---|
| ordered window, 50 of 20k | 3.9ms | 17.0ms | 19.5ms |
| 1k rows, policy-filtered | 29.4ms | 69.1ms | 76.3ms |
| whereId / write round-trip | 1.5ms | 1.6ms | ~3ms |
| write → 100 live subscribers | 1.9ms | 2.1ms | 4.7ms |
| seed 20k (80 transacts) | 1.6s | 2.2s | 10.7s |

Reads are ~10–15% over node+sqlite; small requests carry ~1.5ms of workerd
per-request overhead; bulk writes are the one real gap (local simulator write
path — worth re-measuring on production infra before drawing conclusions).
Local `workerd` is a simulation: production adds user→DO network but runs
Cloudflare's own storage tier. The CEILINGS move up: triples per workspace go from
~2M-per-GB-of-heap to ~10GB of SQLite (the heap no longer holds the store);
idle connections from thousands of open sockets to ~32k hibernated WebSockets;
and the fleet dimension — how many cells — goes from an ops problem to
`idFromName(workspace)`, costing ~nothing while idle. The loss window closes
for free (output gates). Limits worth knowing: 128MB heap per object (fine —
state lives in SQLite, not JS maps), single-threaded by design — which is the
model anyway.

## Compaction policy

```ts
new TripleServer({ schema, policy, retainLog: 10_000 })
```

Once per N commits, entries older than the last N are forgotten — deterministic
in the version number, so restarts change nothing. The store IS the snapshot;
nothing is lost but replayability, and stale cursors resync from state.

Deep dive: SPEC §2, §3, §5.
