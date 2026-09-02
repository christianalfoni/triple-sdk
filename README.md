# Triple SDK

A local-first realtime sync SDK built on RDF-style triples, written to be read.
Zero runtime dependencies — plain `node:http`, `node:sqlite`, and Server-Sent Events;
the same cell runs unchanged as a Cloudflare Durable Object.

The idea in five lines:

1. Every fact is a triple `[subject, predicate, object]`; every change is a delta `{added, removed}` — there is no update.
2. The **log** is the truth (append-only, versioned); the **store** is a fold of it. One adapter owns both, atomically.
3. The **query** is the unit of everything: what syncs, what you read, what notifies you.
4. **Schema is shared shape; policy is server-only logic** — the file boundary is the trust boundary.
5. Writes are **optimistic layers** over confirmed state; ack or reject just drops a layer.

This README is the whole documentation. It is organized by **mechanism**, in the
order a user's action touches them: for each, what goes in, what comes out, and
the rule inside that decides. One dataset runs through every section.
[`SPEC.md`](SPEC.md) is the numbered contract each section cites;
[`GOALS.md`](GOALS.md) records the measured burn-downs behind the numbers.

## The map

| # | mechanism | what it decides | code (`packages/sdk/src/sdk/`) |
|---|---|---|---|
| [1](#1-schema--records-become-predicates) | Schema | which predicates exist and what values they may hold | `shared/schema.ts` |
| [2](#2-query--find-and-shape-compiled-to-a-payload) | Query | which triples a read needs, and what shape they take | `shared/query.ts` |
| [3](#3-transport--four-requests-and-one-stream) | Transport | how a message crosses the wire, and who is asking | `client/transport.ts` · `server/fetch.ts` · `server/http.ts` |
| [4](#4-server-query-execution--roots-from-the-index-policy-inside-the-scan-triples-not-rows) | Server query execution | which triples to **send** | `shared/query.ts` (`collectPayloadTriples`) |
| [5](#5-policy--the-read-filter-and-the-write-check) | Policy | which triples an actor may read; which writes they may make | `server/policy.ts` |
| [6](#6-server-storage--store-and-log-one-adapter-one-transaction) | Server storage | how state and history are kept, atomically | `shared/storage.ts` · `server/sqlite.ts` · `server/durable.ts` |
| [7](#7-client-store--the-triples-you-hold-and-the-two-maps-that-find-them) | Client store | which triples the client holds, and how it finds them | `shared/store.ts` |
| [8](#8-live-query--what-to-show-and-when-to-recompute-it) | Live query | what to **show**, and when to recompute it | `client/client.ts` (`LiveQuery`) · `client/react.ts` |
| [9](#9-transaction--draft-to-intent-to-authoritative-delta) | Transaction | how intent becomes an authoritative delta | `shared/transaction.ts` |
| [10](#10-optimistic-layer--what-the-ui-shows-before-the-server-answers) | Optimistic layer | what the UI shows before the server answers | `client/client.ts` · `shared/store.ts` (`withDelta`) |
| [11](#11-fan-out--who-hears-about-a-commit-and-what-they-hear) | Fan-out | who hears about a commit, and what they hear | `server/server.ts` |
| [12](#12-version-cursor--what-behind-means-and-how-it-heals) | Version cursor | what "behind" means, and how it heals | `client/client.ts` · `server/server.ts` |
| [13](#13-outbox-and-persistence--what-survives-offline-and-reload) | Outbox & persistence | what survives offline and a reload | `client/client.ts` |
| [14](#14-eviction--the-cache-holds-what-the-live-queries-need) | Eviction | what the cache may forget | `client/client.ts` |
| [15](#15-presence-and-ephemeral--live-but-never-history) | Presence & ephemeral | what is live but never history | `server/server.ts` |
| [16](#16-migration--the-schema-generation-freeze) | Migration | what an old client may still do | `server/server.ts` |
| [17](#17-cells--one-workspace-one-process-one-sqlite) | Cells | where a workspace runs | `server/cells.ts` · `server/durable.ts` |

## The running example

The demo's schema and seed. Two users, one team, four todos, and a policy with
one interesting exception:

```ts
export const User = Schema.from({ name: Schema.string() });
export const Team = Schema.from({ name: Schema.string(), member: Schema.ref(User).multiple() });
export const Todo = Schema.from({
  text: Schema.string(),            // required by default → `string`
  completed: Schema.boolean(),
  owner: Schema.ref(User),          // a ref knows its target
  team: Schema.ref(Team).optional(),// → `Ref | undefined`
  tags: Schema.string().multiple(), // → `string[]`, [] when absent
});
export const schema = Schema.build({ user: User, team: Team, todo: Todo });
```

```
user_christian  name "Christian"      team_platform  name "Platform"  member → christian, ada
user_ada        name "Ada"

todo_1  "Understand…"    owner → christian                   completed false
todo_2  "Build…"         owner → christian                   completed false
todo_3  "Decide…"        owner → ada        team → platform  completed false
todo_4  "Ada's private"  owner → ada                         completed false
```

**Policy:** a todo is readable by its owner or by members of its team. Only the
owner writes — except `completed`, which team members may toggle. The log stands
at **version 12**.

Three actions run through the sections: Christian **opens a board** (1–8),
Christian **ticks Ada's team todo** (9–12), and Ada **removes Christian from the
team** (11–12).

---

### 1. Schema — records become predicates

An entity is just its fields; the registry key is its name. `Schema.build`
stamps the name onto each entity and produces two things every runtime layer
consumes: the **flat predicate map** and the **generation hash** (§16).

```
Schema.build({ user: User, team: Team, todo: Todo })  →

schema.flat                                         schema.hash: "ebfc1c47"
  "todo/text"       { type: "string",  multiple: false, optional: false }
  "todo/completed"  { type: "boolean" }
  "todo/owner"      { type: "ref", target: user }
  "todo/team"       { type: "ref", target: team, optional: true }
  "todo/tags"       { type: "string", multiple: true }
  "team/member"     { type: "ref", target: user, multiple: true }
  …
```

**How data moves:** a field name (`text`) becomes a predicate (`"todo/text"`)
the moment it leaves a builder or a draft; a result key goes the other way. Ids
carry their entity as a prefix (`todo_…`), which is how a bare id resolves to a
shape.

**How it is evaluated:** every write, on both sides, runs `validateValue(field,
value)` — type, cardinality, for `Schema.object()` the full shape (§4.7), and
for `Schema.oneOf("admin", "member", "guest")` membership in the declared
values (§4.8; the field types as that literal union) — the client for an early
error, the server authoritatively. Values enter the
store in an **order-preserving encoding** — `s:Decide…`, `n:…`, `b:true`,
`r:user_ada`, `o:{…}` — so lexicographic order *is* value order, which is what
lets a range become an index read (§6).

> ✓ one file shared by both sides; row types are computed from it, never written · ✗ every fact carries its predicate name — verbose next to a column
> SPEC §4 · §4.5 required by default · §4.7 object values

---

### 2. Query — find and shape, compiled to a payload

A query declares what to **find** (`where*`, in your order — you are the
planner), what **shape** to return (`select`, a mirror of the result type), and,
through `watch`/`useQuery`, what to keep **current**. The builder produces
data, not code:

```ts
const board = Query.from(Todo)
  .where("owner", [{ id: "user_christian" }, { id: "user_ada" }]) // set form: IN
  .select({ text: true, owner: { name: true } });
```

```json
toPayload(board) →
{ "constraints": [{ "predicate": "todo/owner",
                    "anyOf": [{ "id": "user_christian" }, { "id": "user_ada" }] }],
  "selection":   { "todo/text": true, "todo/owner": { "user/name": true } } }

queryPredicates(payload) → { todo/owner, todo/text, user/name }   // its routing key (§8)
```

The `where` family, held together by one rule — chained constraints are ANDs,
applied in your order, each filtering what survived the last:

| method | meaning |
|---|---|
| `where(field, value)` · `where(field, [a, b])` | holds this value · holds any of these (no field ever holds an array, so IN is unambiguous) |
| `whereId(id)` | pin to one known subject (§6.7) |
| *(no `where` at all)* | **every instance** you may see, seeded from a required predicate (§6.2) — a scan, so lead with a `where` when you can |
| `whereNot` · `whereAbsent` | negations — refinements; first or alone they mean *every instance, minus*: you cannot scan for what is missing (§0.3), but you can scan for everything and subtract |
| `whereGreater(OrEqual)` · `whereLesser(OrEqual)` · `whereBetween` | ranges on the encoded order |
| `whereEither(branch, branch)` | OR across conditions; may seed as the union of its branches (§6.10) |
| `.orderBy().limit().after(cursor)` | a live window with keyset cursors (§6.6) |
| `.select((todo) => ({ comments: Query.from(Comment).where("todo", todo)… }))` | a correlated subquery — the join, windowed **per parent** (§6.8) |

**How it is evaluated:** nothing runs here. The builder checks types at compile
time; a query with no positive `where` is compiled with `all: ["todo/text"]`,
the predicate every todo holds, so the executor can seed from it. The payload
is inspectable JSON.

> ✓ the wire is data — loggable, diffable, replayable · ✗ no planner: put the selective constraint first, there is no safety net
> SPEC §6.1–§6.2 · §6.5 typing · §6.7–§6.10

---

### 3. Transport — four requests and one stream

Four HTTP shapes carry everything. Identity never travels in a message; the
server derives it from the connection (§7.4).

```
POST /api/query      { kind: "query",    schema: "ebfc1c47", payload }          → { triples, version }
POST /api/transact   { kind: "transact", schema, mutationId: "m17", operations } → ack | reject
POST /api/broadcast  { kind: "broadcast", payload, about? }                      → 202
GET  /api/subscribe?since=12   (SSE)   hello → presence → backlog → delta | repair | resync | ephemeral …
```

**How data moves:** `HttpTransport(baseUrl, headers?)` on the client;
`createFetchHandler(server, resolveActor)` (Workers) or
`createHttpHandler(server, resolveActor)` (node) on the server.
`resolveActor(request)` → `"user_christian"` — a cookie, a header the edge
verified, anything the connection proves.

**How it is evaluated:** the schema hash on every request is checked against
the generations the server accepts. A mismatch is `409` and the client
**freezes** (§16) — no data moves under a shape the server does not know.

> ✓ inspectable, zero dependencies, transport-agnostic server · ✗ a per-reader stream (§11) can never be CDN-cached
> SPEC §7.1 · §7.4

---

### 4. Server query execution — roots from the index, policy inside the scan, triples not rows

`collectPayloadTriples` answers a payload with the **triples** needed to
evaluate it, not with rows. It runs the query to decide what to *send*; the
client will run it again to decide what to *show* (§8).

**Seed via the POS index** — one jump per value of the first constraint:

```
POS["todo/owner"]["r:user_christian"] = { todo_1, todo_2 }
POS["todo/owner"]["r:user_ada"]       = { todo_3, todo_4 }     candidates: t1 t2 t3 t4
```

**Policy inside the scan** — each candidate's constraint triple passes through
`canRead` (§5) *before* it can become a root:

```
[todo_1, todo/owner, →christian]   owner = me                 ✓
[todo_2, todo/owner, →christian]   owner = me                 ✓
[todo_3, todo/owner, →ada]         team platform, member      ✓
[todo_4, todo/owner, →ada]         owner ≠ me, no team        ✗  dropped   roots: t1 t2 t3
```

**Level-order selection walk** — one batched read per (level × predicate),
every triple re-passing `canRead`:

```
level 0   todo/text  over [t1 t2 t3] → 3 triples · refs in todo/owner → { christian, ada }
level 1   user/name  over [christian, ada] → 2 triples
```

**The answer** — eight triples, stamped with the version they were read at, and
no trace of `todo_4`: absent, not redacted.

```json
{ "version": 12, "triples": [
    ["todo_1","todo/text","Understand…"], ["todo_2","todo/text","Build…"], ["todo_3","todo/text","Decide…"],
    ["todo_1","todo/owner",{"id":"user_christian"}], ["todo_2","todo/owner",{"id":"user_christian"}],
    ["todo_3","todo/owner",{"id":"user_ada"}],
    ["user_christian","user/name","Christian"], ["user_ada","user/name","Ada"] ] }
```

Later constraints refine the survivors with one batched read each
(`matchSubjects`); windows rank inside the index (`topSubjects`); a range seed
is an index range read (`matchRange`). Negations are kept **sound on a partial
cache** by shipping *evidence* — the negated predicate's readable triples for
every candidate — so the client judges from what the server said, never from
what its cache happens to lack (§6.9).

**How it is evaluated:** per triple, two tests — does the encoded object satisfy
the constraint, and may this actor read it. An invisible fact costs a check and
never a leak: it cannot surface through a count, a join, or a window (§10.5).

> ✓ O(candidates), two index hops regardless of store size; nothing leaks · ✗ a verdict per candidate — low-selectivity seeds pay the policy bill (measured below)
> SPEC §6.3 · §6.9 evidence · §7.5 the query is the unit of sync · §10.5

---

### 5. Policy — the read filter and the write check

Server-only, one block per entity, one rule per verb, lambdas only. Two things
are declared as data: `fields`, what the rules get to **see of the subject** —
a selection, like a query's — and, once per workspace, the **actor entity**:
rules run *as* a User, and `ctx.actor` is that user's own row. Both are the
engine's leverage: loaded once per subject or actor, batched, cached across a
fan-out, and `fields` makes the **visibility dependency graph static** (§11).

```ts
const Policy = definePolicy({ actor: User });   // ctx.actor: { id, name, role, … } — the User row

export const todoPolicy = Policy.from(Todo, {
  fields: { owner: true, team: { member: true } },
  read:   (ctx) => ctx.fields.owner?.id === ctx.actor.id ||
                   ctx.fields.team?.member.some((m) => m.id === ctx.actor.id),
  create: (ctx) => ctx.fields.owner?.id === ctx.actor.id,   // fields = the state once it lands
  update: (ctx) => ctx.fields.owner?.id === ctx.actor.id,   // fields = as it is now; ctx.after = as it will be
  delete: (ctx) => ctx.fields.owner?.id === ctx.actor.id,
  overrides: {
    // team members may tick a todo they cannot otherwise write
    completed: { write: (ctx) => ctx.fields.team?.member.some((m) => m.id === ctx.actor.id) },
  },
});
export const policy = Policy.build(schema, { user: userPolicy, team: teamPolicy, todo: todoPolicy });
```

**The read filter** (`createReadFilter(storage, policy, actor)`) is a function
over triples. For `[todo_3, todo/owner, →ada]` as Christian:

```
actor          = { id: user_christian, name: "Christian" }               ← loaded once per actor
fields(todo_3) = { owner: {id: user_ada}, team: { member: [{id: user_christian}, {id: user_ada}] } }
read(ctx)      = false || true                                           → ✓
```

Because `ctx.actor` is a row in the cell, "who is asking" is data: the service
mirrors each caller's standing from the identity provider into `User.role`
(`admin` · `member` · `guest`) and rules read it — `shared === true &&
ctx.actor.role === "member"` — with no transport metadata in sight. An actor
with no row yet (`system`, `anonymous`) is `{ id }` alone, so rules are written
positively: undefined denies.

**The write check** (`checkWrite`) groups a delta's triples **by subject** — the
record, not the triple — derives the verb from existence (absent before, present
after → `create`; present both → `update`; present before only → `delete`),
evaluates the entity rule once with that verb's context, then dispatches every
touched field that has an override. All-or-nothing. When Christian ticks
`todo_3` (§9):

```
todo_3  before ✓ after ✓ → update
  todo/completed touched → overrides.completed.write → christian ∈ platform.member  ✓  ALLOW
(had he also renamed todo/text → entity rule: owner-only → ada ≠ christian          ✗  REJECT — whole transaction)
```

**How it is evaluated:** a verdict is `true | false | undefined`, and only an
explicit `true` grants — an optional chain that finds nothing denies, with no
`?? false`. `Policy.build` demands a key per entity: omit one and the code does
not compile. Deny by default, enforced by types.

The declarative fork, measured and declined: an expression form (typed paths,
visible-set compilation, ~35% on adversarial scans, ~0% on realistic reads) was
fully built on this codebase and removed — two rule languages mix badly, and
the wins that matter (policy as scan constraints, CDN reads) demand
declarative-*only*, which is a different system. SPEC §10.7 keeps the argument
with numbers.

> ✓ field-sized permissions on a record-sized verb; what the client receives is already filtered · ✗ rules can reference data the client does not have — so they can never run there
> SPEC §10 · §10.4 verbs · §10.7 the fork

---

### 6. Server storage — store and log, one adapter, one transaction

Everything below the SDK is one interface. It owns **both** the current state
and its history, because a write must land in both atomically — a store that
says v42 while the log stops at v41 is corruption, not lag.

```ts
interface StorageAdapter {
  readonly version: number;                 // highest committed version — cheap, never derived
  readonly epoch: number;                   // this history's identity (§12)
  match(pattern): Triple[];                 // read the store: undefined = wildcard
  apply(delta, actor): LogEntry | null;     // commit: store + log, one transaction; null = nothing changed
  entriesSince(since): LogEntry[] | null;   // catch-up; null = "before my retention floor"
  snapshot(): { version, triples };
  compact?(upTo): void;
  matchSubjects? · topSubjects? · matchRange?   // fast paths; callers fall back
}
```

**How data moves** — `apply` is set semantics: a triple is inserted only if
absent, deleted only if present, and the log records the *effective* delta. On
SQLite (`node:sqlite`, and `ctx.storage.sql` on Durable Objects):

```
DELETE FROM triples WHERE subject='todo_3' AND predicate='todo/completed' AND object='b:false'
INSERT INTO triples VALUES ('todo_3', 'todo/completed', 'b:true')
INSERT INTO log VALUES (13, 'user_christian', 1725…, '{"removed":[…],"added":[…]}')
```

Three b-trees over `triples`: the primary key `(subject, predicate, object)` on
a `WITHOUT ROWID` table — the table *is* the SPO index; `idx_po (predicate,
object)` — "which subjects hold this value", every `where` seeds here; `idx_o
(object)` — "anything pointing at this id", the inbound sweep a delete needs
(§9). SQLite maintains all three inside the statement. `MemoryStorage` is the
same contract over the two Maps of §7 plus an array for the log.

**Reads are synchronous, on purpose** (§5.4). Async is viral through ~1,400
lines of tight loops; a network database would turn hundreds of ~1µs `match`
calls into 100–500ms per query unless every loop compiled into set-shaped SQL —
at which point you are building Zero, with its declarative-only constraints;
and one event loop with no awaits gives **snapshot isolation for free**: nothing
writes during a read, which the policy cache's correctness literally depends
on. Durable Objects validate the decision from the other side: `storage.sql` is
synchronous, input gates keep the object single-threaded, and the output gate
closes the durability window without awaiting per write.

**Compaction:** `retainLog: 10_000` forgets entries older than the last N once
every N commits — deterministic in the version, so restarts change nothing. The
store *is* the snapshot; only replayability is lost, and stale cursors resync
from state (§12).

> ✓ history and state cannot disagree; swap memory / sqlite / DO with identical semantics · ✗ the fsync sits in the write path (WAL; on DOs the output gate hides it), and a network database can only be durability behind the log, never the read path
> SPEC §2 · §3 · §5 · §5.4

---

### 7. Client store — the triples you hold, and the two maps that find them

The client is a small database, not a cache of responses. It holds **triples**,
in the same `Store` class the memory adapter uses, and runs the same executor
over them. The store is two nested Maps — that is the entire index:

```
SPO  Map<subject, Map<predicate, Set<encodedObject>>>   "all facts about X"
POS  Map<predicate, Map<encodedObject, Set<subject>>>   "all subjects where p = v"
```

**How data moves** — Christian's store after the answer of §4:

```
SPO  todo_1 → todo/text → {s:Understand…}, todo/owner → {r:user_christian}
     todo_3 → todo/text → {s:Decide…},     todo/owner → {r:user_ada}
     user_ada → user/name → {s:Ada}                                    …
POS  todo/owner → r:user_christian → {todo_1, todo_2}, r:user_ada → {todo_3}
     user/name  → s:Ada → {user_ada}                                   …
```

Every triple lives in both maps; `#add` creates intermediate branches on demand
and returns `false` if it was already there; `#remove` deletes and prunes empty
branches. Both are set semantics — the same idempotence as the server's
`apply`, which is what makes out-of-order duplicates harmless (§12).

**How it is evaluated:** `match([s, p, o])` with `undefined` as wildcard picks
the map that answers without scanning — subject known → SPO; predicate known →
POS; neither → a full scan, which no query issues (there is no O index on the
client: the delete sweep runs on the server). `Readable.match` is the one
interface the query engine needs, so it does not know whether it is on the
client's Maps or the server's SQLite. Reads are synchronous here too — the
render path, the optimistic overlay and the live re-run all depend on it — which
is why IndexedDB cannot be the read store; it can be persistence (§13).

> ✓ the same executor, the same query, runs on both sides; offline reads and live updates fall out · ✗ ~500 bytes per triple in memory, and CPU spent twice
> SPEC §2 · §7.6

---

### 8. Live query — what to show, and when to recompute it

`client.watch(query)` returns a `LiveQuery`; `useQuery(query)` is how a React
component consumes one. Its lifetime:

1. **Constructor** — `rematerialize(true)`: run the query against the local
   store *now*. A hydrated client paints before, or without, the network.
2. **`refresh`** — `client.load(query)` fetches (§3–§4), applies the triples,
   status becomes `ready`. `await live.ready` if you need to know.
3. **Every delta** — `#notify` computes the predicates the delta touched and
   asks each live query `affectedBy(touched)`: a set intersection against the
   predicates it was built from. Only those re-run — locally, against the store.
4. **`close()`** — the cache may evict (§14).

**How data moves** — `materialize` builds rows at home, per root, through the
selection: predicates bared, refs followed, cardinality applied by the schema
(a `multiple` field is always an array, never `undefined`):

```json
[ { "id": "todo_1", "text": "Understand…", "owner": { "id": "user_christian", "name": "Christian" } },
  { "id": "todo_2", "text": "Build…",      "owner": { "id": "user_christian", "name": "Christian" } },
  { "id": "todo_3", "text": "Decide…",     "owner": { "id": "user_ada",       "name": "Ada" } } ]
```

When Ada later renames `todo_3`, a one-triple delta arrives, touches
`todo/text`, intersects this query's `{todo/owner, todo/text, user/name}`, and
steps 3 → materialize replay. Rows are **fingerprinted**: `todo_1` and `todo_2`
keep `===` identity, so a keyed list re-renders one item.

**How it is evaluated — two rules that keep a partial cache honest:**

- **A root must be whole for what the query reads** (§7.6). Fan-out is filtered
  by permission, not interest (§11), so the store holds strays — a lone
  `completed` for a todo it knows nothing else about. A subject becomes a root
  only when every *required* field the query constrains on or selects is
  present; a stray stays invisible until the query's own fetch completes it,
  and a freshly created entity appears at once (a create carries all its
  required fields in one delta).
- **Windows refill.** An ordered `limit` re-fetches exactly when rows fall out
  and the cache cannot know what comes next; `live.cursor` is the next page for
  `.after()`.

`useQuery` follows React's own identity rule: pass a stable query, or `(make,
deps)` like `useMemo`; it renders through `useSyncExternalStore`, mounting
watches and unmounting closes. `usePresence` and `useTransaction` (§9) come from
the same `createHooks(client)`.

> ✓ cache-first paint, optimistic overlays and live updates are ONE mechanism — a local re-run · ✗ both executors must agree exactly (pinned by the 37-step smoke), and CPU is spent on both sides
> SPEC §6.4 · §6.6 · §7.5 · §7.6 · §11.4 row identity

---

### 9. Transaction — draft to intent to authoritative delta

A write is phrased in records and travels as **intent**. Christian, a team
member but not the owner, ticks Ada's todo:

```ts
await client.transact((tx) => {
  tx.edit(Todo, "todo_3").completed = true;       // a draft: property write → set intent
});
// tx.create(Todo, { text, completed, owner })     // required fields required — forget one, it does not compile
// tx.edit(Todo, id).tags.push("urgent")           // lists are mutated, never reassigned
// tx.delete(id)                                   // sweeps inbound refs (idx_o), refuses if a required ref would dangle
```

**How data moves.** The draft reads the *local* view (confirmed + pending) to
produce two artifacts:

```json
{ "operations": [ { "op": "set", "subject": "todo_3", "predicate": "todo/completed", "value": true } ],
  "delta":      { "removed": [["todo_3","todo/completed",false]], "added": [["todo_3","todo/completed",true]] } }
```

The `operations` are what travels (four verbs: `set` · `add` · `remove` ·
`delete`); the `delta` is only this client's preview (§10). On the server,
`compileOperations` meets truth: it derives the authoritative remove-half from
*its* state, in op order, each op seeing the last one's effect — the client's
guess is discarded. Then the checks: the write policy (§5), and **required
fields** — no surviving subject may lose one, and a delete that would leave a
required ref dangling is refused (§4.5). Then `storage.apply` → **log entry
v13** (§6) → the ack, carrying the server's delta.

**How it is evaluated:** intent is compiled against the server's current state
on arrival, which is what makes a days-old queued write still correct (§13) —
and what makes the four-verb vocabulary a real limit: there is no
server-computed increment, so concurrent edits to the *same field* are
last-write-wins. Collaborative text belongs to a CRDT, deliberately outside this
contract (§11).

`useTransaction((tx, …args) => …)` returns `[run, state]` with `state.kind` in
`idle | pending | committed | queued | rejected` — call-time arguments, no
closures over stale rows.

Mistakes are compile errors, pinned in the `*.type-test.ts` files:

```ts
Query.from(Todo).where("nope", 1);                  // unknown field
Query.from(Todo).where("completed", "yes");         // boolean, not string
tx.create(Todo, { text: "x", owner: { id: me } });  // `completed` missing — required
tx.edit(Todo, id).text = undefined;                 // required fields cannot be cleared
Policy.build(schema, { user: userPolicy });         // Property 'todo' is missing — deny by default
```

> ✓ a partial cache can never corrupt the store; ids are minted on the client so a create is visible before the network · ✗ per-field last-write-wins, and "ops see earlier ops" is a semantics you learn once
> SPEC §8.4 ids · §9.1 intent · §4.5 · §10.4

---

### 10. Optimistic layer — what the UI shows before the server answers

The preview delta of §9 is pushed onto a stack of **pending layers** the moment
`transact` is called. Reads go through a view, not the store:

```
view = withDelta(confirmed, pending₁, pending₂, …)     // removes hidden, adds appear — never applied
```

`withDelta` (in `store.ts`) filters a base's `match` results through a delta:
removed triples vanish, added ones appear. Every live query whose predicates
intersect re-runs over the view — **the checkbox flips at 0ms**, the promise
still unresolved.

**How it resolves:**

- **ack** `{ kind: "ack", mutationId: "m17", version: 13, delta }` — the *server's*
  delta is absorbed into confirmed, the pending layer is dropped, the cursor
  moves to 13. The promise resolves `"committed"`. The view now equals the
  store; if the preview guessed right nothing re-renders.
- **reject** `{ kind: "reject", mutationId: "m17", reason }` — the layer is
  dropped. The UI reverts. There is no undo code anywhere.
- **offline** — the intent goes to the outbox (§13); the promise resolves
  `"queued"`, and the layer stays until the drain acks or rejects it.

**How it is evaluated:** one mutation in flight at a time per client, in order —
a queued write joins the queue rather than overtaking it. Pending layers are
never persisted: only confirmed state and durable intent survive a reload;
previews are recomputed, never trusted from disk.

> ✓ 0ms UI and zero rollback code — rollback is "drop a layer" · ✗ the preview guessed the remove-half from a partial cache; until the ack it can differ from truth
> SPEC §8.1–§8.2 · §13

---

### 11. Fan-out — who hears about a commit, and what they hear

A subscriber is `{ actor, send }` — one SSE stream per tab, tagged with who it
is. **The server keeps no record of anyone's queries.** It routes by
*permission*; the client routes by *interest* (§8). Two questions, answered in
the two places that can answer them cheaply.

When v13 commits, `#prepareFanOut` computes, once per distinct actor and
memoized, the part of the delta that actor may read — additions filtered by the
post-state, removals by the pre-state — and every subscriber receives their
actor's slice. The tick reaches Ada as:

```json
{ "kind": "delta", "version": 13, "actor": "user_christian",
  "delta": { "removed": [["todo_3","todo/completed",false]], "added": [["todo_3","todo/completed",true]] } }
```

**Visibility is fan-out too** (§10.6). Because policies declare their `fields`,
the server knows statically which writes can change whose visibility. When Ada
removes Christian from `team_platform` (v14 — one triple removed from
`team/member`), `#affectedSubjects` walks the dependency map backwards to
`todo_3` and diffs what each actor could see of it before and after:

```
visible("user_ada")        → the one membership triple removed
visible("user_christian")  → removed: EVERY triple of todo_3 he held  (text, owner, team, completed)
                                        — the todo leaves his world as data, no re-query
```

A commit an actor may see *nothing* of still reaches them — as an empty delta
carrying only its version, so every subscriber walks the same log positions and
"behind" stays one number for everyone (§12). That envelope names no `actor`:
who wrote something you cannot see is not yours to know either.

Measured: 0.1ms to fan one write to 500 subscribers; a revocation touching a
500-todo team reaches 500 subscribers in ~22ms. A subscriber whose buffer passes
1MB is disconnected, not buffered forever — it reconnects with its cursor and
the log heals it.

**How it is evaluated:** *may this actor know this fact?* — only the server can
answer, so it does, per actor. *Does this fact change something I show?* — only
the client knows its open queries, so it decides, per predicate set. Two
consequences: everything a client receives is by construction safe to cache,
even when no query wanted it (a memory cost, never a leak); and the server's
per-write cost scales with **distinct signed-in users**, not tabs or queries —
five hundred tabs of twenty people cost twenty filter evaluations.

> ✓ per-reader privacy on every push; permission changes arrive as ordinary deltas, live · ✗ every client hears every write it is allowed to hear, and the stream is per-reader work — never CDN-cacheable (the §10.7 fork)
> SPEC §7.7 · §10.6

---

### 12. Version cursor — what "behind" means, and how it heals

A client's entire sync state is one number: the version through which every
visible effect of the log has been applied to its store. It moves on **every**
push, relevant or not — a stray triple for a todo you never queried still
advances it, because the cursor means "I have seen the log to here", not "I
hold data I care about to here".

**Three rules resolve every race** (`client.ts`, `#applyRemote` and `load`):

| event | rule | why |
|---|---|---|
| push with `version ≤ cursor` | skip | a duplicate — the ack and the stream both carry v13 |
| query answer with `version ≥ cursor` | apply its triples; the cursor does **not** move | an answer is purely additive and cannot say "gone"; jumping the cursor would skip an undelivered removal. Only an empty cache adopts the answer's version |
| query answer with `version < cursor` | discard, ask again (≤ 5 tries) | it was computed before a delta the stream already delivered; applying it would resurrect a removal |

Example: Christian opens a new query at cursor 12 while v13 is in flight.
Answer first (stamped 13): apply, cursor stays 12; then push v13: the remove
deletes the old `b:false` still in his store, the add is already there — a
no-op. Converged, *because apply is idempotent* — the payoff of having no
`update`. Push first: cursor 13; an answer stamped 12 arrives — stale, re-ask.

**Being behind is a ladder** — what the number cannot heal, coarser identities
catch:

| how far behind | detected by | healed by |
|---|---|---|
| in-flight races, redelivery | the cursor | skip — idempotent |
| disconnected minutes or days | `?since=cursor` on reconnect | backlog replay: `entriesSince`, each entry filtered per reader |
| missed a permission change while away | the server, from the backlog | **`repair`**: `{ evict: [subjectIds], refresh: { added } }` — evict by id, refresh by value |
| cursor predates the retained log | `entriesSince → null` | **`resync`**: drop the cache, re-run every live query |
| a different history (new DB, policy deploy) | `hello.epoch` mismatch | resync |
| old client code | schema hash not accepted | **freeze** (§16) |

Repair closes a subtle hole: the backlog is filtered by *current* readability,
so the very entry that revoked your access is invisible to you and you would
keep the stale rows forever. After replay, the server walks the backlog's
policy-relevant subjects once: now-invisible ones are evicted **by id** (never
by value — an actor who never saw a triple learns nothing from its eviction),
still-visible ones get their current readable triples re-sent, which an
up-to-date cache absorbs as no-ops. The invariant suite proves it: an offline
revocation heals at reconnect.

**How it is evaluated:** recovery never has a special path. Replay is the fold
of normal operation; resync is the query path of first load; repair is the
visibility machinery of live revocation. One model, reused.

> ✓ every failure heals through one number plus two coarser identities · ✗ repair re-ships current triples for affected subjects — reconnects after policy churn cost bandwidth
> SPEC §7.3 · §8.2 · §10.6

---

### 13. Outbox and persistence — what survives offline and reload

**The outbox** recovers the write side. A `transact` that cannot be sent lands
as durable intent (`"queued"`), survives reloads, and drains **in order** on
reconnect — each entry compiled against the server's truth on arrival (§9), so
a days-old queue is still correct. If the schema changed meanwhile, entries
that still compile carry over; the rest surface through `onRejected`, never
silently dropped.

**Persistence** is any synchronous string store:

```ts
new TripleClient({ schema, transport, persistence: {
  load: () => localStorage.getItem("todos:ws_1"),
  save: (state) => localStorage.setItem("todos:ws_1", state),
}})
```

Saved ~100ms behind a cheap dirty-check, ~345KB per 10k triples:

| field | why it is there |
|---|---|
| `triples` | the confirmed cache — a cold boot paints before the network answers (§8) |
| `version` | the cursor — reconnect replays only what was missed (§12) |
| `outbox` | queued intent — offline writes survive the reload |
| `schema` | the generation this cache was built by — a mismatch freezes instead of corrupting (§16) |
| `epoch` | which history this cache belongs to — a different server epoch forces resync |

**How it is evaluated:** pending layers are deliberately *not* saved. On boot
the store is hydrated from `triples`, the cursor from `version`, and the outbox
drains through the same path a reconnect uses. The memory store stays the read
path (§7); persistence is a write-behind — which is exactly why IndexedDB is
its natural upgrade (async is fine here, and the 5MB localStorage cap is not).

> ✓ offline writes and cold-start paints from one snapshot · ✗ localStorage today: synchronous writes on the main thread, ~100k triples of headroom
> SPEC §7.6 · §13

---

### 14. Eviction — the cache holds what the live queries need

`LiveQuery.close()` → `client.release(live)` → `#evict`:

1. For every **surviving** live query, run `collectPayloadTriples` — the
   server's own collector — against the local store, and union the keys into a
   `needed` set.
2. Everything in the confirmed store not in `needed` is removed through the
   ordinary `apply({ removed })`, so both maps prune structurally (§7).
3. The persisted snapshot is rewritten.

```
smoke:  evict on close   cache 14 → 12 triples — Ada's name dropped with its last query
```

**How it is evaluated:** set difference over survivors, not reference counts. A
triple two queries share survives when one closes with nothing to count; a
stray that arrived by push for a query since closed stays until the next close
sweeps it (`client.evict()` forces a sweep). The cache after eviction is
precisely what the remaining queries would fetch fresh — computed by the same
code that fetches them.

> ✓ the one unbounded growth on the client is closed; persistence size tracks open queries, not session length · ✗ strays accumulate between closes, bounded by the writes you may read
> SPEC §7.6 · §11.1

---

### 15. Presence and ephemeral — live, but never history

Being online is a fact about the connection, not the domain, so it never
touches the log. On subscribe a client receives the roster **once**; from then
on everyone gets O(1) diffs — `{ joined }` when an actor's *first* connection
opens, `{ left }` when their *last* closes (two tabs are one presence).
Ordering is guaranteed: `hello`, roster, then diffs.

```ts
client.onPresence((online) => …);      const online = usePresence();
client.broadcast({ cursor: [x, y] });                    // to everyone here
client.broadcast({ dragging: rect }, { about: todoId }); // only to peers who may SEE todoId
client.onEphemeral((actor, payload) => …);
```

**How it is evaluated:** `broadcast` rides the same stream and never the log —
no version, no replay; coalesced ~33ms per key, so 60 drag frames a second
reach peers as ~30 messages and zero log entries; capped at 16KB; and `about:`
runs the entity's read policy (`canSeeSubject`) so presence honors the same
visibility as data. The dividing rule: **if it should survive a refresh, it is
a triple; if it should die with the tab, it is a broadcast.** When the drag
settles, one `transact` records where it landed.

> ✓ multiplayer state without poisoning the log · ✗ miss it and it is gone — exactly right for a cursor, wrong for anything else
> SPEC §13

---

### 16. Migration — the schema generation freeze

Old code keeps running: tabs stay open for days, offline devices return weeks
later. Client and server each hash the shape they were built with (§1) and the
hash rides every request and the `hello`. There is no registry and nothing to
bump — the code *is* the version.

```ts
new TripleServer({ schema, policy, compatibleSchemas: [PRE_EXPAND_HASH] })
```

**How it is evaluated:** a server accepts its own generation plus the
allow-list. A client whose generation is not accepted **freezes** — reads and
writes throw, live queries flip to `status: "outdated"`, the UI says "refresh".
Deliberate: a stale client that keeps writing is how data corrupts. The
allow-list is the migration window, and the operator decides when it closes.

The doctrine — accrete, never break: **expand** (new fields arrive `.optional()`;
the previous hash goes in `compatibleSchemas`), **backfill** (a migration actor
writes through `server.commit()` — connected clients receive it *live* as
ordinary deltas; migrations are writes, not downtime), **contract** (drop the
compat hash, flip fields required, delete dead ones). Retyping goes through
`Schema.union(Schema.string(), Schema.number())` so every reader is forced by
the type system to handle both while the backfill runs. Policy-only deploys —
same shape, new rules — are the **epoch**'s job instead: new epoch, clients
resync (§12).

> ✓ staleness cannot be silent, and the wire never lies about its shape · ✗ a hard freeze: old clients STOP unless the window lists them
> SPEC §4.5 · §7.3

---

### 17. Cells — one workspace, one process, one SQLite

```
router ──► process ──► cell = TripleServer + workspace.db     (× many per process)
```

A **cell** is a workspace's whole backend: its own data, log, versions, epoch.
Workspace ↔ DB is 1:1 forever; processes are the elastic layer. One process
owns a workspace at a time — the log's single-writer rule — and **realtime and
data live in the same worker**, because fan-out is computed at commit time
against pre- and post-state (§11); split them and you recreate the dual-write
problem between two services. Global features (search, analytics) come from
shipping every cell's log into one stream, never from cross-cell queries.

```ts
const host = createCellHost({
  createCell: (ws) => new TripleServer({ schema, policy, storage: new SqliteStorage(`data/${ws}.db`) }),
  resolveActor: (req, ws) => authenticate(req, ws),   // membership lives here
});
// the client: the workspace is just the base URL — new HttpTransport(`/w/${ws}/api`)
```

**Durable Objects are this design as a managed runtime**, almost line by line:

| this design | Durable Objects |
|---|---|
| synchronous adapter reads (§6) | `ctx.storage.sql.exec()` — same-isolate SQLite |
| write-through durability, loss window noted | the **output gate**: messages leave only after writes are durable |
| "nothing writes during a read" | input gates — single-threaded across awaits, runtime-enforced |
| a cell per workspace, single writer | one DO per `idFromName(workspaceId)` — the platform's guarantee, not your discipline |

Porting was three files — `DurableStorage` (same SQL), the `fetch`/SSE binding,
and the platform's routing in place of `createCellHost`. Executor, policy, log,
recovery: untouched. The ceilings move up: triples per workspace from ~2M per GB
of heap to ~10GB of SQLite; idle connections to ~32k hibernated sockets; the
fleet dimension from an ops problem to `idFromName`, costing nothing while idle.

Adopting the ideas in an existing system, in the order that works — each step
independently valuable and reversible: **introduce the log** (every write also
appends `{version, actor, delta}`); **stamp reads** with the version they were
computed at, so clients gain a cursor; **fan out from the log**, replacing any
separate notification path — this is where room and data merge; **move
permissions server-side, into the scan**; **one worker per workspace**. The trap
at every step: two sources of truth for the same fact.

> ✓ a workspace fits one process; the ~5,000-user envelope below is *per workspace* · ✗ one workspace larger than a machine's RAM is the boundary — that is where you are building Zero and should use it
> SPEC §12

---

## Why this design

Three commitments, each carried end to end through the sections above:

1. **Everything hard is one mechanism.** Realtime, optimistic writes, offline
   replay, catch-up, migration, audit — all of it is *fold an append-only log of
   deltas*. State = fold(log); behind = one number; rollback = drop a layer.
   There is no cache-invalidation story anywhere, because every layer is a
   derivation of the one to its left.
2. **Permissions are data flow, not a gate.** Policies filter inside the scan,
   so an invisible row is indistinguishable from an absent one — and a
   permission change arrives as a delta: live in ~22ms, after offline via
   `repair`. If your product has private rows inside shared spaces, this is the
   feature you would otherwise discover you needed a year in.
3. **The unit of everything is the workspace.** One cell = one process + one
   SQLite file ≈ 5,000 concurrent users — and a cell deploys unchanged as a
   Durable Object, where the single-writer rule and the durability window
   become platform guarantees.

The API surface, in one table:

|                           |                                                                    |                                                              |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Schema & entities**     | typed shape, shared by both sides; required by default             | `Schema.from` → `Schema.build`, `.optional()`, `.multiple()`, `Schema.object()`, `Schema.oneOf()`, `Schema.ref(() => …)` |
| **Typed queries**         | find + shape in one, result types computed                         | `.where()` (values or sets), `.whereNot/Absent/Greater/Lesser/Between`, `.whereEither()`, `.whereId()`, subqueries |
| **Ordered windows**       | pagination over a set: explicit order, keyset cursors, live refill | `.orderBy().limit().after(live.cursor)`                      |
| **Live queries**          | the only read: data, status, per-query reactivity                  | `client.watch()`, `useQuery()`                               |
| **Writes**                | drafts → intent; optimistic layer; outcome reported                | `client.transact((tx) => …)` → `"committed" \| "queued"`, `useTransaction()` |
| **Permissions**           | entity verbs + declared fields + the actor's own row, filtered inside the scan | `definePolicy({ actor })` → `Policy.from(Entity, rules)` → `Policy.build(schema, …)` |
| **Realtime**              | SSE push, per-reader filtered; permission changes arrive as deltas | `client.connect()`                                           |
| **Offline**               | cache + write queue survive reloads; drain in order when healed    | `persistence`, `onRejected()`                                |
| **Presence**              | who's online — roster once, O(1) diffs; unlogged broadcasts        | `usePresence()`, `broadcast()`, `onEphemeral()`              |
| **Migrations**            | accrete-never-break, compat windows, schema freeze                 | `compatibleSchemas`, `Schema.union()`                        |
| **Durability & cells**    | log+store in one transaction; a workspace per cell                 | `SqliteStorage`, `DurableStorage`, `createCellHost()`        |

## Measurements

`pnpm bench` — in-process, so the numbers are the SDK's cost, not the network's
(M-series laptop, 60k triples, 20 users, full policy on):

```
                                    memory    sqlite (durable)
query, 1k rows policy-filtered      5.6ms     7.0ms
query, ordered window of 50         0.6ms     1.4ms
write (3-triple transact)           0.05ms    0.13ms
seed 60k triples                    21ms      143ms · survives restart ✓

fan-out   write → 500 subscribers 0.1ms · revocation on a 500-todo team ~22ms
client    1k-row live query re-runs per delta in 0.01ms, stable row identity
windows   50 of 10k policy-filtered roots on a 600k store: 4.5ms mem / 11.6ms sqlite
```

**Query-engine scaling** (100k todos, policy on) — cost tracks the candidate set
and the result, never total store size, except scan seeds:

```
                                       memory    sqlite
whereId · windowed 50 · refinements    ≤0.3ms    ≤1ms      O(result): POS / topSubjects index paths
equality seed → 1k roots               1.8ms     4.0ms     O(candidates)
negation / absence / range refine      ≤1.9ms    ≤5.4ms    batched, one read per constraint
set-form seed → 10k candidates         14ms      37ms      policy verdicts dominate — selectivity is your lever
range as the SEED at 100k              23ms      2.0ms     sqlite: index range read (was 57ms)
whereEither                            +~15% over its dominant branch — the OR is free
join, 20 windowed parents              1.1ms     —         windowed parents keep recursion small
```

**The same cell on Durable Objects** (20k todos, localhost HTTP, `wrangler dev`,
the unchanged smoke suite passing against it):

| | node + memory | node + sqlite | Durable Object (workerd) |
|---|---|---|---|
| ordered window, 50 of 20k | 3.9ms | 17.0ms | 19.5ms |
| 1k rows, policy-filtered | 29.4ms | 69.1ms | 76.3ms |
| whereId / write round-trip | 1.5ms | 1.6ms | ~3ms |
| write → 100 live subscribers | 1.9ms | 2.1ms | 4.7ms |
| seed 20k (80 transacts) | 1.6s | 2.2s | 10.7s |

Reads within ~10–15% of node+sqlite; ~1.5ms of workerd per-request overhead on
small requests; bulk writes are the one real gap (local simulator write path —
re-measure on production infra before concluding).

**Capacity envelope** — one process, full policy, measured:

| | |
|---|---|
| Memory cost | ~500 B/triple → ~2M triples per GB heap; SQLite is disk-bound beyond that |
| Sustained writes, fan-out live | ~5,000/sec @ 500 subscribers · ~3,500/sec @ 5,000 |
| Cold hydrations | ~500/sec full 1k-row · ~3,000/sec windowed 50-row |
| Client persistence | ~345KB per 10k triples (localStorage holds ~100k) |

With real-app assumptions (active users write 0.1–0.5 ops/sec, hydrate windowed
on open), **one process serves ~5,000 concurrent users on millions of triples**
— per workspace under cells (§17). The remaining ceilings and their designed
fixes live in SPEC §11; `GOALS.md` records the three burn-downs that produced
these numbers (revocation 2552→22ms, sqlite windows 62→12ms, queries 42→7ms).

## How it compares

Every row is a different answer to one question: *what is the unit of fan-out?*

|                 | Unit of sync                                               | Permissions                                            | Writes                                                         | Where it wins                                                                                   |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **This SDK**    | the query, per-reader filtered                             | per-triple, in the scan; revocation arrives as a delta | owned end-to-end: intent ops, optimistic layers, offline queue | workspace products: private-by-row data inside shared spaces, one integrated contract           |
| **ElectricSQL** | the shape (table + WHERE), identical bytes for all readers | at the shape boundary, via your proxy                  | none — bring your own API; Electric tails the WAL              | shared data to unlimited readers: CDN does the fan-out (1M clients, flat latency)               |
| **Zero**        | synced queries with server permissions + IVM               | declarative, server-evaluated                          | custom mutators                                                | instant local reads at scale; closest cousin to this design                                     |
| **Replicache**  | key-value spaces, poke + pull                              | in your push endpoint                                  | mutation replay (the pattern our outbox borrows)               | the proven minimal loop; predecessor to Zero                                                    |
| **InstantDB**   | triple queries (InstaQL) on one shared cloud DB            | rule expressions                                       | transactions with optimistic apply                             | the same triple bet, as a hosted platform                                                       |
| **Yjs / CRDTs** | the document                                               | none — whole doc or nothing                            | merge functions, character-level                               | collaborative TEXT — the one thing per-field LWW cannot do (our ledgered boundary)              |

The core fork: **per-reader streams (this SDK, Zero) cannot be CDN-cached;
cacheable streams (Electric) cannot carry per-row privacy.** Audience logs —
partitioning streams by policy-derived audience — are the ledgered bridge (SPEC
§11.1). Electric's own history is the cautionary tale: it began as a full
local-first framework like this one and retreated to read-path-only sync in
2024 — adoption beat integration. This repo keeps the full contract because it
exists to understand it.

## The repo

A pnpm monorepo: the SDK, and a real service built on it.

| package | what it is |
|---|---|
| [`packages/sdk`](packages/sdk) | **triple-sdk** — every mechanism above, plus its demo and test harness (`smoke`, `invariant`, `bench`, `hooks`) |
| [`packages/schema`](packages/schema) | the service's shared SHAPE — the §10.1 trust boundary as a package boundary |
| [`packages/worker`](packages/worker) | the whole backend, one `wrangler deploy`: edge auth (WorkOS AuthKit, WebCrypto, zero deps) + membership gate + a Durable Object cell per workspace, serving the app's static assets |
| [`packages/platform`](packages/platform) | **workspace-platform** — apps as data: an MCP endpoint per workspace where coding agents write drafts and publish releases, all entities under the workspace's own policy ([its README](packages/platform/README.md) documents the protocol) |
| [`packages/app`](packages/app) | the React app: private todos, a shared board, live presence — `useQuery`/`useTransaction` all the way down |

```
packages/sdk/src/sdk/shared/   types · value · store · storage · schema · query · transaction · protocol
packages/sdk/src/sdk/server/   server · policy · fetch (Workers) · http (node SSE) · sqlite · durable · cells
packages/sdk/src/sdk/client/   client (watch / transact / connect) · transport · react
packages/sdk/src/demo/         the todos & teams app: shared/schema · server/policy · client · smoke · invariant · bench
```

Start with `shared/types.ts` — the whole vocabulary is five types.

The service in one sentence: **workspace = WorkOS organization = one Durable
Object**; the edge decides who may enter a workspace, the policy decides what
they see and touch inside — and unsharing a todo is a live revocation other
members watch happen (`pnpm service:smoke` proves it end to end, keylessly).

## Run it

```bash
pnpm dev           # demo at localhost:5173 — open TWO windows, they sync live
pnpm smoke         # 37 steps against a real server (memory, or RDF_DB=.data/app.db for sqlite)
pnpm invariant     # state === fold(log), both adapters · policy · repair · whole roots
pnpm bench         # the measurements
pnpm typecheck     # the type-level tests — typecheck IS the test
pnpm service:dev   # the real service on workerd: edge auth + a cell per workspace
pnpm service:smoke # 13 steps: privacy, override, live revocation, draft/publish, audiences, guests, invites
```

### The workspace as a platform

Each workspace cell also speaks [MCP](https://modelcontextprotocol.io) — a
coding agent connects to `/w/<workspace>/mcp`, reads the schema, writes
**draft** files, and **publishes**. Apps, drafts and releases are entities in
the workspace schema itself, so a publish is a transaction, releases are
immutable by policy, and a running app learns about its new version through an
ordinary `useQuery`. Apps are plain ES modules served under an implicit shell
(Tailwind + an import map — no build step), and they are pure clients: they
hit the same `/api` as everything else, as the signed-in viewer, under the
same policy. The protocol, the model and the trade-offs are in
[`packages/platform/README.md`](packages/platform/README.md).

Try it locally (no WorkOS needed — `packages/worker/.dev.vars` sets `DEV_AUTH=1`):

```bash
pnpm app:build && pnpm --filter worker platform:build
pnpm service:dev                  # then, once up: pnpm --filter worker seed
```

Point an MCP client at `http://localhost:8787/w/org_dev/mcp`, ask it to build
an app, and open the URL `publish` returns.
