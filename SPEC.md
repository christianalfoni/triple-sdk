# Triple Store SDK — Specification

A minimal local-first sync SDK built on RDF-style triples.

This document is the contract. Every file in `src/sdk/` refers back to a numbered
section here. If code and spec disagree, one of them is a bug.

---

## 0. Why triples

Four properties of the triple model drive every design decision below. Read these
first; the rest of the spec is downstream of them.

### 0.1 A store is a *set* of triples

No order. No duplicates. Adding the same triple twice is a no-op.

This is why sync is tractable: `add` is idempotent and commutative, which is most of
a CRDT for free. Two peers that apply the same set of adds in different orders end up
in the same state.

### 0.2 There is no "update" — only `add` and `remove`

Changing a value is two operations:

```
- (alice, user/name, "Bob")
+ (alice, user/name, "Christian")
```

Consequence: **any API that sets a value must first know the current value**, in order
to emit the matching remove. This is the single biggest ergonomics problem in the SDK,
and §9 (Entity API) exists entirely to solve it.

### 0.3 Open world

The absence of a triple means "unknown", not "false".

- In permissions this is what you want: a triple you filtered out is indistinguishable
  from one that never existed, so there is no leak.
- In validation it is a trap: you cannot conclude "this field is missing, therefore
  invalid" without an explicit closed-world rule. We do not attempt validation in v1.

### 0.4 Identity is global, values are local

A subject is a string id that means the same thing everywhere. A value is a plain JS
scalar. We never use RDF blank nodes (locally-scoped anonymous ids) because two peers'
blank nodes are unrelated, which makes them unmergeable. Every entity gets a real id
at creation time, minted on the client (§8.4).

---

## 1. Data model

```ts
type Id     = string                          // an entity id, e.g. "user_a1b2"
type Value  = string | number | boolean | Ref // a literal, or a pointer
type Ref    = { id: Id }                      // a pointer to another subject
type Triple = [subject: Id, predicate: Id, object: Value]
```

A predicate is a namespaced string: `"user/name"`, `"todo/completed"`.

Everything that ever moves through the system is a **Delta**:

```ts
type Delta = {
  added:   Triple[]
  removed: Triple[]
}
```

Client → server, server → client, into storage, out of the log. One shape.

### 1.1 Triple equality

Triples are compared by value, not reference. Two triples are the same triple if all
three positions are equal. `Ref` equality is by `.id`.

Because the store is a set, `apply` must dedupe: adding a triple that is already
present changes nothing, and the resulting delta reported to subscribers must be empty.

### 1.2 Ordering of a Delta

Within one delta, **removes are applied before adds**. This makes a replace
(`remove old value` + `add new value`) safe regardless of array order.

---

## 2. Store

An in-memory set of triples with two indexes. Both are nested Maps — there is no
clever data structure here.

| Index | Shape | Answers |
|---|---|---|
| `SPO` | `Map<subject, Map<predicate, Set<object>>>` | "all facts about entity X" |
| `POS` | `Map<predicate, Map<object, Set<subject>>>` | "all entities where p = v" |

These two cover essentially every query an app makes. A third (`OPS`) would only be
needed for unbound-predicate reverse lookups, which we do not have.

### 2.1 Interface

```ts
match(pattern: Pattern): Triple[]   // pattern positions may be undefined = wildcard
apply(delta: Delta): Delta          // returns the *effective* delta (see 1.1)
has(triple: Triple): boolean
snapshot(): Triple[]
```

`apply` returning the effective delta is important: callers (the log, the subscription
router) must react to what actually changed, not what was requested.

### 2.2 Object keys

`Set<object>` cannot hold `Ref` objects directly — two `{id:"x"}` are different object
identities. Objects are keyed by an encoded string (`encodeValue`) and decoded on read.

---

## 3. Log

An append-only, monotonically versioned list of everything that has happened.

```ts
type LogEntry = {
  version: number   // 1, 2, 3, ... monotonic, no gaps
  delta:   Delta    // the *effective* delta from Store.apply
  actor:  Id       // who made the change
  at:      number   // wall clock, for display only — never for ordering
}
```

This is the spine of the system. Realtime fan-out (§7), reconnect catch-up (§7.3),
optimistic rebase (§8) and provenance all read from it.

### 3.1 Provenance lives here, not in the triple

Classic RDF adds a fourth position to every triple (the "named graph") to record where
a fact came from. We do not. The log already records actor and time per change, which
is strictly more information, and it keeps the triple a 3-tuple.

**This is the one deferral with a migration cost.** Adding a 4th position later means
touching both indexes and the wire format. We accept that.

`actor` is stamped, never validated or resolved to an entity. It is supplied by the
transport, which authenticated the connection — never by the client (§7.4). Writes the
server makes itself through `commit()` default to `"system"`, since there is no
connection to derive an actor from.

Nothing reads it yet. What will: §10, both for audit ("who changed this") and for
policies that depend on authorship ("you may edit only what you wrote"). It is **not**
what lets a client recognise the echo of its own write — `mutationId` does that, and it
is more precise, since two tabs of the same user share an actor but not a mutation.

It is kept because §3.1's argument depends on it: drop `actor` and the case for a
3-tuple goes with it.

### 3.2 Version is the sync cursor

A client stores the highest version it has seen. On reconnect it sends that version and
the server replies with every entry after it. Versions are assigned by the server only.

---

## 4. Schema

Replaces the whole of RDFS for v1. No inference engine.

The unit of declaration is the **entity**: a plain object of fields. Its NAME is
the key it is registered under in `Schema.build` — stated once, nowhere else — and
the wire predicates (`todo/text`) are generated from it. `Schema.build` stamps each
entity with its key (a hidden symbol), which is how standalone call sites
(`Query.from(Todo)`, `tx.edit(Todo, …)`) resolve predicates without being handed
the registry. The triple layer (§1–§3) never sees an entity — `flattenEntities`
collapses the definitions into the flat `predicate → { type, multiple }` map it
consumes.

```ts
const User = Schema.from({ name: Schema.string() })
const Team = Schema.from({ member: Schema.ref(User).multiple() })
const Todo = Schema.from({
  text:      Schema.string(),                 // required — the default (§4.5)
  completed: Schema.boolean(),
  owner:     Schema.ref(User),                // a ref KNOWS its target entity
  team:      Schema.ref(Team).optional(),     // private todos have no team
  tags:      Schema.string().multiple(),
  priority:  Schema.union(Schema.string(), Schema.number()),  // string | number
})

export const schema = Schema.build({ user: User, team: Team, todo: Todo })
```

`Schema.from` defines ONE entity; `Schema.build` assembles the registry — the same
from/build pairing the policy side uses (§10.1).

`Schema.ref(User)` carries its target in the type. That is what lets query selections
(§6.5) and policy contexts (§10.2) nest with bare keys — nesting into `team` knows it
lands on Team.

### 4.7 Object values — structure without identity

```ts
position: Schema.object({ x: Schema.number(), y: Schema.number() }).optional()
```

A structured value stored as ONE triple and replaced WHOLE on every change.
That wholeness is the point, not a limitation: when members only ever change
together, per-field LWW can TEAR them — client A sets `x`, client B sets `y`,
and the merged position is a corner neither meant. An object value makes the
struct the atom, so concurrent writes race as a unit.

The identity rule decides when to use one: **an object value has no identity —
nothing can point at it, query into it, window by it, or protect part of it.
The moment you want any of those four, it is an entity.** The type system
enforces the consequences: members are declared with the SAME builders as
fields (scalars, unions, `.optional()`, nested objects) but never refs and
never `.multiple()`.

Why builders rather than a bare TS generic: the shape must be RUNTIME data —
it feeds the schema hash (reshaping an object is a generation change, §7.3, or
migration would be blind exactly where structured data lives) and it validates
every write, on both paths: the draft throws early, the server rejects
authoritatively (this also ended §4.2's "types are advisory": every written
value is now checked against its declared type). Encoding is canonical —
member order never creates a second identity — and ref-ness is decided by the
SCHEMA, never by a value's shape, which also let `delete`'s inbound-ref sweep
become schema-driven: one POS lookup per ref predicate instead of the old
full-store walk.

### 4.4 Mutual references — the thunk form

An entity must exist before it is referenced — unless the reference is a THUNK,
resolved lazily at first use (always after both consts exist):

```ts
// type aliases break the TYPE cycle (TypeScript cannot infer circular types);
// thunks break the VALUE cycle. Aliases, not interfaces — only aliases carry
// the implicit index signature EntityDef requires.
type PersonFields = {
  name: FieldBuilder<"string", false, false>;
  dog: FieldBuilder<"ref", false, true, DogFields>;
};
type DogFields = {
  called: FieldBuilder<"string", false, false>;
  human: FieldBuilder<"ref", false, false, PersonFields>;
};
const Person: PersonFields = Schema.from({
  name: Schema.string(),
  dog: Schema.ref((): DogFields => Dog).optional(),
});
const Dog: DogFields = Schema.from({
  called: Schema.string(),
  human: Schema.ref((): PersonFields => Person),
});
```

Traversal then works through the cycle in both directions — selections, policy
fields, subqueries alike. Acyclic schemas keep the plain form and full inference;
the annotations are the cycle's one honest cost. Proven at runtime in
`invariant.ts` (the person↔dog round trip) and at the type level in
`query.type-test.ts`.

Builders are immutable: `.multiple()` returns a new builder, so one held in a
variable can be reused without one call site altering another's field.

### 4.1 What `multiple` decides

Can this `(subject, predicate)` pair hold more than one value? "A user has one name,
but many todos." Two behaviors derive from it:

| | `multiple: false` | `multiple: true` |
|---|---|---|
| **Write** (§9) | **replace** — emit remove(old) + add(new) | **append** — emit add(new) only |
| **Conflict** (§8.3) | last write wins | set union |

### 4.2 `multiple: false` is maintained, not enforced

Nothing in the store stops two triples from sharing a subject and predicate — it is a
plain set (§0.1). `multiple` is read by exactly one thing, `Transaction`, which uses it
to decide what a write emits. The constraint lives in the write path, not in the store.

So concurrent writes can violate it:

```
A reads (todo_1, todo/text, "milk") → emits -("milk") +("from A")
B reads (todo_1, todo/text, "milk") → emits -("milk") +("from B")

server applies A → store holds "from A"
server applies B → the remove of "milk" is a no-op, the add lands
                 → store holds BOTH "from A" and "from B"
```

**Closed** by §9.1: the server does not trust the client's remove half. It derives it
from its own state, so the later write wins and the field settles on one value.

### 4.3 A relationship is one triple, read both ways

There is no back-reference in this schema, and there should not be one. A relationship
is **one** triple; both directions are queries over that single fact, and both are
direct index hits (§2):

```
stored:   (todo_1, todo/owner, →user_christian)

"who owns todo_1?"           match([todo_1, "todo/owner", _])       → SPO index
"what does christian own?"   match([_, "todo/owner", →christian])   → POS index
```

A document database stores a back-reference (`user.todoIds`) because there is no other
way to find children. A triple store indexes every predicate in both directions by
construction — **the POS index is the inverse**. Storing the back-edge as well is
redundant data that has to be kept in sync, and will eventually drift.

What *does* justify a second predicate is a genuinely different fact — "starred todos",
where a user stars todos they do not own. That is not an inverse.

See §11 for the deferred `inverse` schema field, which would name the backward read
rather than declare a second thing to write.

### 4.5 Required is the default — and it is enforced, or the types would lie

A single-valued field types as `T` unless marked `.optional()`, which makes it
`T | undefined`. Multiple fields are `T[]` either way — an empty array already
expresses absence.

The open world (§0.3) cannot guarantee presence, so the claim is made true at the
**write path**: after §9.1 normalization and the policy check, the server rejects any
write that would leave a surviving subject without a required field. That covers a
create that omits one, an update that removes one, and — as a side effect worth
naming — **referential integrity**: deleting an entity that another subject holds a
required ref to is refused until the ref is reassigned or the holder deleted.

`commit()` bypasses this like everything else: migrations need to write transitional
states. Which yields the migration doctrine: **new fields arrive `.optional()`** —
required would instantly invalidate every existing row — and are flipped to required
only after a backfill (README, Migrations).

Two places deliberately stay lenient:

- **Policy contexts** (§10.2) type every field `| undefined` regardless: a rule may
  be looking at a pre-create state where nothing exists yet.
- **A `fields.read` override** (§10.4) can hide a required field from a reader whose
  query selects it; prefer `.optional()` for any field with a per-field read rule.

`Schema.union(Schema.string(), Schema.number())` types a field `string | number`.
Values are self-describing at runtime, so nothing below the type level changes;
members must be scalars. Its main job is the RETYPE migration — widen, backfill,
verify, narrow — forcing every reader to handle both meanwhile.

### 4.6 A subject's id prefix declares its entity

`newId("todo")` mints `todo_…`, and every write checks that a predicate's entity
matches its subject's prefix — eagerly in the typed Transaction, authoritatively in
`compileOperations` — so a `note/*` triple can never land on a `user_*` subject.
Entity membership is a declaration, not an accident of which predicates happen to be
present; it is what makes verb derivation, required-field grouping (§4.5) and delete
semantics well-defined per subject.

### 4.4 What the schema deliberately does not do

No `subClassOf`, no `domain`/`range`, no entailment, no required fields, no validation.
Types are ENFORCED on write (since §4.7): every value — scalar, union member, or
object shape, recursively — is validated against its declared type on both
paths: the client's draft throws early, the server rejects authoritatively.

---

## 5. Storage adapter

One interface, two server implementations: `MemoryStorage` (shared with the client)
and `SqliteStorage` on Node's built-in SQLite — a `triples` table, a `log` table, and
`apply()` as one SQL transaction across both, with the epoch persisted alongside the
data so a restart is the SAME history (§7.3) and clients replay instead of resyncing.
Measured at 60k triples: ~2× memory's write cost, ~3× its query cost.

`node:sqlite` is synchronous, which is why it fits the contract untouched; Postgres
requires the async-adapter refactor (§11.1). IndexedDB (client) also pending.

```ts
interface StorageAdapter {
  match(pattern: Pattern): Triple[]
  apply(delta: Delta, actor: Id): LogEntry | null   // null if delta was a no-op
  entriesSince(version: number): LogEntry[]
  snapshot(): { version: number; triples: Triple[] }
}
```

The adapter owns *both* the store and the log, because a write must land in both
atomically or catch-up breaks.


### 5.4 The async question — settled

Network databases (Postgres, DynamoDB) cannot implement this interface: every
`match` here is synchronous, and making it async is VIRAL — the executor's
scan-loops, the policy's fields loader, every server handler. Catalogued, that
is: `resolveRoots`/`windowedRoots`/`collectPayloadTriples` (dozens of awaits per
query), `fieldsLoader` (per subject), `checkWrite`, `canSeeSubject`, and both
HTTP handlers. Every batching win in §11.4 exists precisely because sync reads
made round trips visible and shameful.

The DECISION: reads never go async. The cells architecture (§12) already
guarantees a workspace fits one process, so the working set lives in memory (or
node:sqlite, which is memory-speed); a network database earns its keep as
DURABILITY, not as the read path. The shape for Postgres is write-through:

- `apply()` commits to the in-memory store and appends to an in-process log
  buffer SYNCHRONOUSLY — correctness and fan-out never wait on the network.
- A flusher streams buffered log entries to Postgres (one table, the §3 log)
  with backpressure; `retainLog` compaction applies there too.
- Boot folds the durable log (or a snapshot + tail) into memory — §2's
  `state = fold(log)`, now across a restart with a remote log.
- The cost is a WINDOW: entries acknowledged locally but not yet flushed are
  lost if the process dies. Cells that cannot accept that window fsync a local
  WAL (sqlite already does) and treat Postgres as the second copy.

This is the same conclusion Figma's LiveGraph and Linear's sync engine reached:
the serving tier reads from memory it can trust; the database is where truth
sleeps. Going async-viral instead would tax every layer of this codebase for
the benefit of exactly the deployments that outgrew a cell — and those want
read replicas fed by the log (§12), not awaits in the scan loop.

**The managed form of this decision exists: SQLite-backed Durable Objects.**
Synchronous same-isolate SQL (`ctx.storage.sql`), output gates that make the
write-through loss window a platform guarantee (nothing leaves the object
before writes are durable), input gates that enforce our "nothing writes during
a read" for free, and one-object-per-id — the §12 single-writer invariant as a
runtime property. A cell deploys there by swapping the adapter and the
transport binding; everything above §5 is unchanged — DONE in `src/do/` +
`durable.ts`/`fetch.ts`: the unchanged 35-step smoke suite passes against
`workerd`, and reads measure within ~15% of node+sqlite (README, Measurements).

---

## 6. Query

```ts
const myTodos = Query.from(Todo)              // rooted at an entity
  .where("owner", { id: userId })             // ordered constraints, bare keys
  .where("completed", false)
  .select({                                   // result shape
    text: true,
    tags: true,
    owner: { name: true },                    // nested keys are USER's fields
  })

client.query(myTodos)
// [{ id: "todo_1",
//    text: "buy milk",
//    tags: ["rdf", "basics"],
//    owner: { id: "user_1", name: "Christian" } }]
```

Builders are immutable, like `FieldBuilder` (§4): every method returns a new query, so
one held in a variable can be extended without altering the original. The wire still
speaks namespaced predicates — `toPayload` generates them from the entity.

### 6.1 Two halves, two shapes

The halves are deliberately not written the same way, because they are not the same
shape:

| | Shape | Written as |
|---|---|---|
| `.where()` | a linear, ordered sequence | a **chain** |
| `.select()` | a tree | a **nested literal** |

Constraints are a sequence — each narrows what survived the last. A result is a tree —
`todo → owner → name`. Forcing either form onto the other half makes both worse: a
chain expressing a tree needs callbacks, and a literal expressing an ordered sequence
loses the ordering guarantee that §6.2 depends on.

This is the split Datomic makes for the same reason (datalog to find, pull to shape).

### 6.2 Order is preserved, and you are the planner

Constraints run in the order written. Conjunction is commutative, so order never
changes the **answer** — but each constraint runs once per surviving subject, so it
changes the cost a great deal. Measured over 500 todos of which 3 are incomplete:

```
.where(completed, false).where(owner, →u)    3 → 1 survivors,   5 index lookups
.where(owner, →u).where(completed, false)   50 → 1 survivors,  52 index lookups
```

Same single result, ten times the work. There is no cost-based optimizer, so the
selective constraint belongs first and that is the actor's job. A planner that
reordered freely would be a different system; see §11.1.

### 6.3 Execution

Two steps, both against the indexes of §2:

1. **Resolve roots.** The first constraint goes straight from `(predicate, value)` to
   subjects via the POS index. Each later constraint is one SPO lookup per surviving
   subject, keeping those that match.
2. **Materialize.** Walk the selection tree per root. `true` takes the value; a nested
   object follows the ref and recurses.

**The schema decides array vs scalar** (§4.1), not the data. A `multiple` predicate
always yields an array — empty, never undefined, when the subject has no such triple —
and a single one yields the value or `undefined`. So the result shape is a consequence
of the schema and does not shift with the contents of the store.

Selecting into a non-ref field throws; it is a schema mistake, not a runtime condition.

`runQuery` takes a `Store`, so the same executor serves the client today and the server
when queries move over the wire (§7).

### 6.4 Reactivity

Each live query records the set of **predicates** it touched during execution. When a
delta arrives, any query whose predicate set intersects the delta's predicates is
re-run from scratch and its subscriber notified if the result changed.

Built. A live query records its predicate set — constraints plus the whole selection
tree — and the client re-runs only the queries a delta's predicates intersect. Change
detection is a JSON fingerprint of the result, so a query that touched a changed
predicate but produced the same answer does not notify.

Deliberately naive: the re-run is from scratch. Real incremental maintenance is
deferred (§11.1).

### 6.6 Ordered windows — pagination over a set

The store is a set (§0.1): "the first 50" means nothing until you say by what.

```ts
const page1 = Query.from(Todo).where("owner", ref).orderBy("text").limit(50)
const page2 = page1.after(live.cursor!)   // keyset: the last row's (value, id)
```

`orderBy` carries the field in the builder's TYPE, so `.after(cursor)` needs no
restating and types the cursor's value; before `orderBy` it does not compile (no
order, no "after"). `LiveQuery.cursor` hands you the next page's cursor ready-made.

- `orderBy` accepts single-valued scalars only; missing values sort LAST in either
  direction; ties break on subject id — the order is total and stable.
- The server resolves roots, ranks, applies the cursor, and collects triples for
  **the window only** (order-field triples travel too, so the client sorts
  identically with the same shared code).
- Ranking rides the ORDER-PRESERVING value encoding (numbers use the IEEE-754
  bit trick, so lexicographic = numeric): adapters rank via `topSubjects` — SQL
  with cached `json_each` statements and a pinned join order, memory with a
  bounded top-K — and the POLICY IS DEFERRED to window-sized batches, walking the
  cursor until the window fills. Invisible rows are skipped, never counted, so
  §10.5 semantics are exact while O(candidates) policy checks become O(window).
- Cursors are keyset (`after (value, id)`), never offsets — offsets lie under
  concurrent writes. "Load more" is stacked queries, each cursored on the previous
  page's last row.
- A LIVE window maintains itself: rows pushed in displace the edge locally; when
  rows fall out (a delete, a re-sorting edit) the cache cannot know what comes
  next, so if the server's last answer filled the window the query refetches —
  underflow triggers refill, a short server answer ends it.

### 6.5 A query is typed by the entity it is rooted at

`Query.from(Todo)` is the entry point, so the builder carries the entity's types:

- `.where()` autocompletes Todo's fields and checks the constraint value against the
  field's declared type. `.where("completed", "yes")` is a compile error.
- `.select()` accepts only Todo's fields; nesting is allowed only into refs, and the
  nested keys are the TARGET entity's fields — `Schema.ref(User)` carries the target
  in its type.
- The result type is **computed**, not written by hand, and its keys are the bare
  field names. There is no namespace to strip and no collision to guard against —
  within one entity, field names are unique by construction.

| Declared | Result type | Because |
|---|---|---|
| single (required) | `T` | presence is enforced at the write path (§4.5) |
| `.optional()` | `T \| undefined` | the triple may simply be absent (§0.3) |
| `.multiple()` | `T[]` | always an array, empty rather than undefined (§6.3) |
| `Schema.union(a, b)` | `A \| B` | values are self-describing at runtime |
| ref + nested selection | the target's result | `.select()` recurses into the target |

`ResultOf<typeof query>` exposes the computed type, so callers never restate a row
shape the query already determines.

These types are asserted in `query.type-test.ts`: `npm run typecheck` is the test. A
mistake in `EntityResult` usually degrades everything to `any`, which no runtime test
would catch.

### 6.7 Pin to one subject — "load this entity"

```ts
Query.from(Todo).whereId("todo_1").select({ text: true, owner: { name: true } })
```

`whereId` pins the root set to one known subject: zero or one row, no `.where()`
needed and no window wanted. Three rules keep it honest:

- The id prefix must match the entity (§4.6) — `Query.from(Todo).whereId("user_1")`
  throws eagerly, before the wire.
- `.where()` constraints still apply: the pinned subject must satisfy every one.
- The visibility gate is "you may read at least one of its facts". An entity whose
  every triple is hidden from you yields zero rows — an invisible subject is
  indistinguishable from an absent one (§0.3, §10.5), so existence never leaks.

### 6.8 Correlated subqueries — the join

```ts
Query.from(Team)
  .where("member", { id: me })                    // roots FOUND by the query
  .select((team) => ({                            // ← the row being built, AS A REF
    name: true,
    todos: Query.from(Todo)
      .where("team", team)                        // the correlation, explicit
      .where("completed", false)                  // an ordinary query: filter it,
      .orderBy("text").limit(5)                   // order it, window it — PER TEAM
      .select({ text: true }),
  }))
// → { id, name: string, todos: { id, text: string }[] }[]  — one row per team
```

The callback form of `.select()` receives the row being built as a **ref** —
`{ id }`, exactly what a ref-valued `.where()` accepts — so the correlation is
written down, not implied: `where("team", team)` says "this todo's team IS this
row". Unknown selection keys hold these subqueries; each yields an array of its
rows on the result. **When the root is one id you already hold, you do not need
this** — `Query.from(Todo).where("owner", { id: me })` is the forward spelling.
The join earns its keep when the QUERY finds the roots: "my teams, each with
their todos" is otherwise N+1 queries stitched client-side — N subscriptions, N
round trips, no single snapshot version. Here it is one round trip, one
consistent snapshot, one live unit.

Mechanics:

- Callbacks work at ANY ref depth: `member: (member) => ({ name: true, todos:
  Query.from(Todo).where("owner", member)… })` — each level's callback receives
  the handle of ITS row, and the subquery correlates there (on the wire it is
  path-addressed: `path: ["team/member"]`). A handle from another level is
  refused eagerly — a subquery references the row it is attached to.
- On the wire, the pinned constraint travels as `{ predicate, parent: true }` —
  an explicit marker, never a sentinel value that data could collide with. The
  executor binds it per parent row; encountering one UNBOUND is an error.
- A subquery is a full query: its own `where` chain, order, window. Unordered
  subquery rows sort by id — the set has no order to inherit (§0.1).
- Typo safety is per key: a selection key that is a real field follows the field
  rules; an unknown key must hold a subquery — either way the error names it.
- The handle is a value with ONE identity: pass it as-is. Spreading it makes an
  ordinary (and meaningless) ref — `toPayload` recognizes the handle itself.
- Visibility: the subquery's constraint triples gate as always (§10.5) — a
  hidden `todo/team` ref never reveals its todo. Collection recurses per
  (root, subquery), each recursion batched internally; windowed parents keep the
  recursion count small.
- Reactivity: the subquery's predicates join the parent's predicate set (§6.4),
  so a NEW todo filed under your team appears live.

It is the read-side answer the cut `inverse` field (§4.3, §11.2) was reaching
for — a QUERY concern, not schema: nothing new is stored, the POS index already
serves the reverse lookup — and it generalizes where a schema-declared back-ref
could not: per-parent filters, order and limits come for free.

### 6.9 Refinements — sets, negations, ranges

```ts
Query.from(Todo).where("owner", [me, ada])            // IN: field ∩ values ≠ ∅
Query.from(Todo).where("owner", me).whereNot("completed", true)
Query.from(Todo).where("owner", me).whereAbsent("team")     // private todos
Query.from(Todo).where("owner", me).whereGreaterOrEqual("text", "m")
Query.from(Todo).where("owner", me).whereBetween("text", "a", "m")  // inclusive
```

- `where` with an ARRAY is the IN of the system — one symmetric rule: match if
  the field's values and the given values intersect. Unambiguous because no field
  ever holds an array (§4.1). An empty array matches nothing.
- Negations (`whereNot`, `whereAbsent`) REFINE, never seed: you cannot scan for
  what is missing (§0.3) — a query still opens with a positive `.where()`,
  `.whereId()` or `whereEither`. A policy-hidden triple already reads as absent
  (§10.5), so negation and visibility agree by construction.
- **Negation soundness on a partial cache (§7.6):** the client re-derives roots
  from whatever its cache holds — and there, a missing triple looks exactly like
  absence. So the server ships the negation predicate's readable triples for
  every subject that reached the negation (a superset of anything the client can
  seed), and the client judges from evidence, not silence. Deltas keep it
  current: negated predicates are part of the query's watched set (§6.4).
- Ranges ride the order-preserving encoding (§6.6): one comparison rule for
  strings and numbers, and a future SQL pushdown is `BETWEEN` on the object
  column. Orderable scalars only — refs and lists do not rank. A range MAY seed
  (it scans its predicate).

### 6.10 `whereEither` — OR across conditions

```ts
Query.from(Todo).whereEither(
  (todo) => todo.where("owner", me).where("completed", false),
  (todo) => todo.where("team", { id: teamId }),
)
```

A subject survives if ANY branch matches in full: ANDs inside a branch, OR
between branches, and the whole constraint ANDs with the rest of the chain. It
may seed the query — the root set is then the union of the branches' roots. For
"one of these VALUES of one field", pass an array to `.where()` instead (§6.9);
`whereEither` is for alternatives across DIFFERENT conditions. Branches carry
constraints only — no windows, ids or subqueries inside.

---

## 7. Sync

### 7.1 Protocol

| Message | Direction | Payload | |
|---|---|---|---|
| `query`       | C → S | `{ schema, payload }` — constraints + selection | built |
| `queryResult` | S → C | `{ version, triples }` | built |
| `transact`    | C → S | `{ schema, mutationId, operations }` — intent, not deltas (§9.1) | built |
| `ack`         | S → C | `{ mutationId, version, delta }` | built |
| `reject`      | S → C | `{ mutationId, reason }` | built |
| `subscribe`   | C → S | `GET /api/subscribe?since=N` (SSE) | built |
| `delta`       | S → C | `{ version, actor, delta }` | built |
| `hello`       | S → C | `{ epoch, version, schema, compatible }`, first on every stream | built |
| `resync`      | S → C | cursor predates the retained log — rebuild from state | built |

`subscribe` is not a JSON message: it is the act of opening the Server-Sent Events
stream, with the cursor in the URL. Everything the server pushes is a `delta`.

### 7.2 Server authority

The server is the only writer of versions and the only arbiter of conflicts. There is
no peer-to-peer merge, no vector clock, no CRDT algebra. A client proposes a delta; the
server accepts or rejects it.

### 7.3 Catch-up

A fresh client (version 0) subscribes **live-only**: its state comes from queries, not
from replaying history. On reconnect it subscribes with `?since=<version>` and the
server replays the log backlog after that version, then continues live. The transport
reconnects itself with backoff, consulting the client's current version each attempt.

Backlog entries are permission-filtered against the CURRENT state — the best a replay
can do.

**Snapshots and the stream.** Every state answer (`queryResult`) is stamped with the
version it was computed at, and the stream and the request travel on different
channels — so a pushed delta can overtake an in-flight snapshot. Two rules keep them
coherent:

- A snapshot is applied only if its version is **at or beyond the cursor**; a stale
  one is re-fetched (versions only grow, so this converges). Applying it would
  resurrect triples a newer delta already replaced.
- The **cursor is stream-owned** once the cache holds anything: a mid-session load
  or an ack never advances it, because jumping past undelivered stream entries would
  version-skip their removals — an additive snapshot cannot express "this triple is
  gone". Only an empty cache (fresh client, or just after a resync) adopts the
  snapshot's version as its starting cursor.

How much log to retain is the STORAGE ADAPTER's choice (§5): `entriesSince` returns
`null` for a cursor older than the retention floor, and the server answers the
subscribe with `resync` — same history, but the gap is unreplayable, so the client
falls back to state exactly as it does on an epoch change: drop the cache, re-run
every watched query. Compaction is therefore safe by contract: it can never corrupt
a catch-up, only force a rebuild.

Every stream opens with a `hello` carrying the server's **epoch** — its history+policy
generation, defaulting to process start. A reconnecting client that sees a different
epoch cannot trust its cache (the store may have been reseeded, the policy
redeployed): it drops the confirmed store and re-runs every watched query. This is
also what protects an in-memory deployment across restarts, where versions reset.

**Schema generations freeze the client — unless listed as compatible.** A deploy may
pass `compatibleSchemas: [priorHash]` to keep already-shipped clients serviceable
through a migration's expand window; the contract deploy drops the entry and the
stragglers freeze. The migration actor knows what broke, so that is who says so.

**Otherwise:** Both sides compute a stable hash of the
schema's shape (`schemaHash`) from the code they run; the client sends it on every
`query` and `transact` (refused with 409 on mismatch) and compares it against the
`hello`. On mismatch the client goes **outdated**: the stream closes, every read and
write throws, and watched queries flip to status `"outdated"` — the app freezes
loudly and asks for a refresh. Degrading instead would mean answering with
predicates the other side does not have, which reads as "no data": silently wrong.
The epoch heals a cache; a schema mismatch cannot be healed by data at all, because
it is the *code doing the folding* that is old.

### 7.4 Identity comes from the connection

The client never says who it is. `transact` carries no actor, and the server does not
read one from the message body — it takes the identity the **transport** established
when it authenticated the connection:

```
createHttpHandler(server, resolveActor)      // resolveActor: (req) => Id | null
                          ^^^^^^^^^^^^^
                          session cookie, verified bearer token, mTLS peer — whatever
                          this deployment authenticates with. null ⇒ 401.
```

Anything the client sends about its own identity is a claim, not a fact. A field in the
message body is fully under the caller's control, so trusting it means any client can
write as anybody. The connection is the only thing the server established itself.

This is also why `TripleClient` takes no `userId`. An application that needs to know
who it is — to scope its own queries — holds that itself; it is not the SDK's business
and it is not what the server acts on.

The same rule governs §10: a permission check runs against the resolved identity, never
against a self-declared one.

### 7.5 The query is the unit of sync

There is no "fetch the store". A client asks for a query and receives **the triples
needed to answer it locally** — the constraint triples that identify the roots, plus
the selection triples, recursing through refs.

```
C → S   query        { constraints, selection }
S → C   queryResult  { version, triples }
```

Deliberately not the materialized result. The client applies the triples to its own
store and then runs the *same executor the server would have used*, which is why a
local write updates a watched query with no further round trip.

The schema is not sent. Both sides already have it, and sending it would let a client
redefine the shape of the data it is asking about.

A watched query owns its own results, status and subscribers:

```ts
const todos = client.watch(myTodos)
todos.subscribe((rows) => render(rows))
todos.data      // synchronous, [] until loaded
todos.status    // "loading" | "ready" | "error"
todos.close()
```

Subscribing per query rather than per client is what makes §6.4 work: the client knows
each query's predicate set, so a delta wakes only the queries it could have changed.

### 7.6 The local cache is partial, and that changes what a read means

With a full replica, a pattern that matches nothing proves nothing exists. With a
query-scoped cache it only means *"not in anything I have synced"* — the open-world
problem of §0.3, now with a second source of absence.

Three consequences, and they are why `pull`, `client.subscribe` and the low-level
`match`/`value`/`values` were all removed rather than kept alongside:

- **A query needs a status.** Empty and not-yet-loaded are different, so the query
  carries `loading`/`ready`/`error` and the caller can tell them apart.
- **Reading outside a query is meaningless.** `client.snapshot()` remains as an
  inspection hatch for the demo's triple panel, and is documented as such — not as
  a way to read data.
- **The cache needs eviction.** Closing a query re-collects what every surviving
  query needs (the server's own collector, run locally) and drops the rest — the
  cache holds exactly the union of its live queries, plus whatever pushes have
  added since the last close.
- **A root must be whole for what the query reads.** Fan-out is filtered by
  permission, not by interest (§7.7), so a client receives deltas for entities it
  never queried and keeps their triples — a lone `completed` for a todo it holds
  nothing else of. A later query seeding from that triple would materialize a row
  missing a field its type promises. So a subject only becomes a root when every
  *required* field the query constrains on or selects is present in the store.
  Not every required field of the entity: a query legitimately holds only what it
  asked for (§7.5), and that partiality is fine — the check is scoped to the
  query's own reads precisely so it hides the stray and never a fetched row. The
  server never sees a difference (§4.5 keeps every subject whole); a freshly
  created entity appears at once, since a create carries all its required fields
  in one delta. Lists (`multiple`) have no completeness signal and may show a
  subset in that window — they degrade, they do not crash.

---

### 7.7 Fan-out is permission-filtered per subscriber

The emission itself is transport-generic: the server's entire notion of a client is
`{ actor, send }` — `subscribe()` registers the callback, fan-out calls it with
plain `StreamMessage` objects, and `http.ts` is merely the adapter that serializes
them onto SSE. A WebSocket binding, an in-process test harness, or a rigged-ordering
transport for race testing are all just different `send` functions.


Every committed delta is pushed to every subscriber — filtered to what that
subscriber's actor may read, and computed BEFORE the delta is applied:

| Half | Filtered against | Because |
|---|---|---|
| `removed` | the **pre**-state | the post-state says you cannot see what you just lost |
| `added` | the **post**-state (an overlay of the delta) | you can only see it once it exists |

So you are told about removals of what you COULD see and additions of what you CAN
see — deleting your own todo pushes its removals to you, and nothing to anyone who
never saw it.

A subscriber whose visible delta is empty still receives the message: the version
cursor must advance for everyone, or the next reconnect would replay entries they
already skipped.

The actor's own write echoes back on its stream too. The client's cursor makes that
a no-op: `transact`'s ack already applied the delta at that version, and any pushed
delta at or below the client's version is skipped. This also resolves the race
between an ack and a concurrent push — whichever arrives first wins, the other is
skipped by version.

Server-side `commit()` — seeds, migrations — fans out through the same path.

The ack is the actor's own filtered view too, visibility diffs included (§10.6):
give an entity away and the ack carries the removes that clean it out of your own
cache entirely.

---

## 8. Optimistic client

### 8.1 Two layers, never merged

```
confirmed store  ← only ever written by server deltas (query results, acks, pushes)
pending deltas   ← local mutations not yet answered, in order
```

Every read resolves against the confirmed store with the pending deltas layered over
it — each layer is a `withDelta` overlay, the same primitive the policy's `after`
state uses (§10.4). The confirmed store is never polluted with unconfirmed data, so
a rejection is a clean discard rather than an unwind.

A `transact` becomes visible SYNCHRONOUSLY: the delta is pushed onto the pending
layer and affected queries re-run before the network is touched.

### 8.2 The rebase loop

- On `ack`: apply the server's effective delta to confirmed (not our own — §9.1 may
  have derived removes the client could not see), then drop the pending entry.
- On `reject`: drop the pending entry. The UI reverts on its own, because reads
  recompute from `confirmed + remaining pending`.
- On a remote `delta`: apply to confirmed, keep pending as-is. Reads recompute.
- On a network failure: same as reject. There is no offline queue (§11.1).

There is no replay of local mutation *functions*, only of the deltas they produced —
`build` runs exactly once, against `confirmed + pending` at that moment.

**Sends are serialized**: one mutation in flight at a time, in the order written.
Concurrent HTTP requests can reach the server out of order, and a delta built on an
earlier optimistic write is only valid once that write has landed — out of order, the
server would see an update to a subject that does not exist yet and derive the wrong
verb (§10.4). The optimistic layer keeps the UI instant; only the wire waits. A
failed send does not break the chain — later mutations still go out, though one built
on a rejected write's state will usually be rejected for the same reason (an honest
cascade, not corruption: each rejection just drops its own layer).

### 8.3 Conflicts

Resolved by `multiple` (§4.1). `false` → the later version in the log wins.
`true` → both survive, because the store is a set (§0.1).

### 8.4 Client-minted ids

`user_` + a random suffix, generated locally. An optimistic create needs no round trip
and no id reconciliation, because the id the client chose is the id the server stores.

---

## 9. The write API — drafts

One way to write: inside `transact`, address a record and mutate a DRAFT of it
(the Immer idiom — mutate a scoped draft, changes are extracted as intent).

```ts
await client.transact((tx) => {
  tx.edit(Todo, todoId).text = "buy oat milk"
  // single → `set` intent; the remove-half of §0.2 is derived (locally for the
  // preview, authoritatively by the server, §9.1)

  const fresh = tx.create(Todo, {        // mints the id (§8.4); REQUIRED fields
    text: "ship it",                     // are REQUIRED — forgetting one is a
    completed: false,                    // compile error, not a §4.5 rejection
    owner: { id: me },
  })
  fresh.tags.push("urgent")              // multiple → `add` intent
  fresh.tags.remove("q3")                // multiple → `remove` intent
  fresh.team = undefined                 // optional → clears (remove intents)

  tx.delete(oldId)                       // every triple, plus inbound refs
})
```

The rules that keep drafts honest:

- Draft typing mirrors query results (§4.5): required singles are `T` —
  assigning `undefined` does not compile; optional singles clear with it.
- Lists are MUTATED (`push`/`remove`), never reassigned — reassignment cannot
  map to add/remove intent honestly, so it is a compile error.
- Draft READS return the current local value (storage plus this transaction's
  own edits), so `if (todo.completed) …` works mid-transaction.
- `edit` addresses any KNOWN id — existing, or fixed-id creation (the verb is
  derived from existence, §10.4); `create` mints.
- Underneath, nothing changed: property writes record the same `set`/`add`/
  `remove`/`delete` intent ops in write order; the wire and the server are
  untouched. React consumption is `useTransaction`: `[run, state]`, with state
  following the §8.2 outcomes.

A transaction accumulates the ops plus an optimistic `Delta` preview and is sent
as one `transact` message.

---

### 9.1 The wire carries intent; the server compiles it

A transaction produces two artifacts: **operations** — `set` / `add` / `remove` /
`delete`, the intent, which is what travels — and a **delta**, the client's
optimistic preview of them, compiled against its own partial cache for the pending
layer only. The server never sees that preview.

`compileOperations` turns intent into truth, applying each op in order against an
evolving view of the store:

| op | compiles to |
|---|---|
| `set` | remove every CURRENT value of the field (the server's view, not the client's), add the new one — a stale or empty cache cannot fork a single-valued field |
| `add` / `remove` | append / drop one value (cancelling pairs collapse, so setting a field to its current value is a true no-op that burns no version) |
| `delete` | remove every triple of the subject plus every inbound ref — including the ones the client never synced |

Two sets of one field in one transaction settle on the last, because the second op
sees the first's effect. The compiled delta is what the policy (§10.4), the required
check (§4.5) and the log receive; `delete` also feeds the policy its verb explicitly
instead of the verb being inferred from what remains.

---

## 10. Permissions

```ts
// a check is any (ctx) => boolean|undefined, inline — only an explicit `true`
// grants, so optional chains deny naturally when a ref is absent

export const todoPolicy = Policy.from(Todo, {
  fields: {
    owner: true,                  // depth 1 — field comparison
    team: { member: true },       // depth 2 — traversal along the ref
  },
  read:   (ctx) => ctx.fields.owner?.id === ctx.actor ||
                   ctx.fields.team?.member.some((m) => m.id === ctx.actor),
  create: (ctx) => ctx.fields.owner?.id === ctx.actor,  // fields = ONCE IT LANDS (§10.4)
  update: (ctx) => ctx.fields.owner?.id === ctx.actor,
  delete: (ctx) => ctx.fields.owner?.id === ctx.actor,
  overrides: { notes: { read: (ctx) => ctx.fields.owner?.id === ctx.actor } },
})

const policy = Policy.build(schema, { user: userPolicy, team: teamPolicy, todo: todoPolicy })
new TripleServer({ schema, policy })
// coverage is the KEYS: every entity name is a required property, so omitting
// one is an ordinary missing-property error naming the gap
```

Rules attach to the **entity** — one `read` rule and three write verbs — because that
is the granularity policies actually have. Per-field `fields.read` overrides cover the
exception: a field more private than the rest of its entity. Checks are ordinary app
code, not SDK vocabulary — the demo writes every one inline. Per-field `overrides`
give a single field a stricter read than its entity. Server only —
`TripleClient` never takes a policy and never needs one, because what it receives is
already filtered.

Each policy is standalone and mentions only its own entity; `Policy.build(schema,
{ … })` takes one per entity KEYED BY the registry names — omitting one entity, or
a verb from a rule, is a compile error: deny-by-default enforced by the type system
rather than by remembering. The from/build pairing mirrors the schema side. The
boundary is total: the schema module contains no policy concepts at all — policies
import the schema, never the reverse — and `Policy.build` verifies each key's
policy was built from that very entity (object identity), while `TripleServer`
verifies the policy was built from the very schema it runs.

### 10.1 Shape is shared, policy is not

Two things get called "the schema", and they have opposite trust properties:

| | Shape | Policy |
|---|---|---|
| What | predicates, types, `multiple` | who may read and write what |
| Kind | data | logic |
| Where | `shared/schema.ts`, both sides | `server/policy.ts`, server only |

The client needs no policy for **correctness**: because the check runs inside the scan
(§10.5), the triples it receives are already filtered, and it runs the same executor
over less data. It could only want a policy to *predict* a rejection, which is a UX
affordance and may be wrong without breaking anything.

And it could not evaluate one correctly anyway: rules reference data the client may
not hold or may not be allowed to see. Client-side evaluation is not merely untrusted,
it is **wrong** — which settles the design rather than leaving it a judgement call.

The physical split is the enforcement. If policy lived in the shared module, one
careless import would ship it.

### 10.2 An entity policy declares its `fields` — a selection, at any depth

A field comparison is a traversal of depth 1, so both are declared the same way: the
policy's `fields` is a **selection**, the same bare-keyed form as a query's
`.select()`, built by the same `materialize`. `ctx.fields` therefore has the same
computed type as a query row:

```ts
fields: { owner: true, team: { member: true } }
// ctx.fields: { id: Id; owner: Ref | undefined; team: { id; member: Ref[] } | undefined }
```

Note every field is `| undefined` here even when required (§4.5): a policy's view is
LENIENT, because a rule may be evaluating a pre-create state where the guarantees do
not hold yet. Query results trust §4.5; policy contexts never do.

Traversal follows refs: `team: { member: true }` walks Todo's `team` ref into Team.
If there is no ref path from the subject to the data a rule needs, that is a modeling
gap, not a policy limitation.

Because `Policy.from(Entity, …)` is one inference site per entity, the compiler verifies the
declared `fields` supply what the checks read — a check reaching for
`ctx.fields.team` under `fields: { owner: true }` is a compile error, as is a
reusable check demanding a field the declaration lacks. (A single call inferring
all policies at once cannot do this: fields and checks would share one inference
variable, which is circular.
`policy.type-test.ts` pins these guarantees; `npm run typecheck` is the test.)

**Why declared rather than read imperatively inside the check:** `fields` is a
value on the policy, readable before any check runs. That is what lets the engine
load it once per (fields, subject) and share it across every check on that subject —
one entity's read rule and all its field overrides read one load — and what makes
batching across subjects and pushdown into the query (§6.2) possible later, since you
cannot batch reads that only come into existence while a function body executes. The
cache lives for exactly one evaluation: nothing writes during a query, so a load
loaded at the start is still correct at the end.

What a fixed-depth selection cannot express — recursion, unbounded traversal — falls
to `ctx.read(subject, predicate)`, the unbatchable escape hatch.

### 10.3 Policy reads are unfiltered; deliveries are not

Deciding whether you may read `todo/text` requires reading `todo/owner`. If *that*
lookup were itself filtered the definition would be circular, and the answer would
depend on evaluation order. So `ctx.fields` and `ctx.read` see the raw store.

A field used in a policy's `fields` is still subject to its own read rule when **returned**.
Same triple, two paths — unfiltered for deciding, filtered for delivering. Without
that, appearing in some rule's `fields` would silently make a field world-readable,
the opposite of what a security-relevant field should get.

### 10.4 Writes are checked per subject, per verb, against the state where the entity exists

The unit of write authorization is the **subject**, not the triple. The delta's
triples are grouped per subject, and the verb is derived from existence before and
after the change:

| | |
|---|---|
| nothing before | `create` |
| nothing left after | `delete` |
| otherwise | `update` |

That entity's verb check then runs ONCE per subject, and each verb sees the
state(s) in which the entity actually exists:

| verb | `ctx.fields` is… | `ctx.after` |
|---|---|---|
| `create` | the entity ONCE IT LANDS — there is no pre-state | — |
| `update` | the entity as it is now | the same fields, once the delta lands |
| `delete` | the entity as it is now — there is no post-state | — |

Post-states are materialized against an overlay of the delta (`withDelta`), so a
traversal sees them at any depth. Only `update` carries two states, and it needs
both: against the pre-state alone the landing state cannot be validated (nothing
stops giving a todo away, or moving it into a team you are not in); against the
post-state alone anyone may SEIZE an entity by writing themselves in as owner.

The demo's todo policy is the payoff: all three verbs are literally the same check,
`ctx.fields.owner?.id === ctx.actor` — a create must name you (its fields ARE the
landing state), an edit must have been yours, and a seizure fails because update
judges the pre-state.

**Per-field `write` overrides.** Create and update judge PER TOUCHED FIELD: a
field with `overrides: { completed: { write } }` is decided by that rule — it
REPLACES the entity rule for that field's changes, exactly as `read` overrides
replace the read rule — while every other touched field shares one entity-rule
verdict, evaluated at most once. `delete` is exempt: removing the subject is not
a field-sized decision. The demo uses it for the collaborative middle ground —
team mates may toggle `completed` on a team todo while renaming stays owner-only
(proven cross-actor in `invariant.ts`).

Note that `tx.delete` also removes inbound refs sitting on OTHER subjects; those
groups correctly evaluate as `update` under their own entities' policies.

Checks run **after** §9.1 normalization, so the server-derived removes are covered
too, and all-or-nothing: a partially applied transaction would leave the client's
optimistic state unreconcilable.

`TripleServer.commit` bypasses the policy deliberately: it is the server writing
directly, for seeding and migrations. Anything from a client goes through `transact`.

### 10.5 The check is pushed into the scan

Filtering applied to results leaks through counts, joins and negation, so it happens
inside `collectPayloadTriples` — both in `resolveRoots`, so an entity you cannot see
never becomes a root, and in the selection walk, so an individual field can be
withheld (via a `fields.read` override).

A triple's predicate names its entity (`todo/text` → the `todo` policy); a predicate
whose entity has no policy is unreadable and unwritable. Since `Policy.build`
requires a key for every entity and `Policy.from` requires every verb, omitting
either is a compile error — deny-by-default enforced by the type
system rather than by remembering.

An entity you may not see is indistinguishable from one that does not exist (§0.3).
That is deliberate: the alternative leaks existence. It also means the UI can show an
empty result but never "you do not have access".

### 10.6 Visibility follows permissions

A permission change IS a delta. Two mechanisms, for the two ways permissions change:

**Data-driven changes** — remove someone from a team, hand off an owner — are caught
by the **dependency map** built from the declared contexts (§10.2): every predicate
in a policy's `fields` is recorded with the ref path from the policy's root to it. When a delta
touches such a predicate, the path is walked backwards to find the subjects whose
visibility may have shifted, and for each subscriber the fan-out diffs those
subjects' triples — pre-state under the pre-filter against post-state under the
post-filter — and synthesizes the adds and removes:

- a REVOCATION arrives as removes of everything access granted (leave a team and
  the team's todos vanish from your cache, live)
- a GRANT arrives as adds of the full triples, not just the membership edge
- the actor's own ack carries their diff, so giving an entity away cleans it out
  of your own cache

This is only possible because contexts are declared: the visibility dependency graph
is static. Reads made through the `ctx.read` escape hatch are invisible to it — a
rule that traverses imperatively opts out of live revocation (§11.1).

**Policy-code changes** — a deploy — are covered by the **epoch** (§7.3): new epoch,
clients drop their cache and re-query. The default (process start) makes every
deploy a policy epoch automatically.

**Catch-up is covered too** — differently, because the pre-states the live path
diffs against are gone from a replayed log. After the backlog, the server sends
one `repair` message: it walks the backlog's policy-relevant subjects (the same
dependency map, §10.6) against CURRENT state — subjects now invisible to this
actor are evicted BY ID (never by value: an actor who never saw a triple learns
nothing from its eviction), and still-visible ones get their current readable
triples re-sent, which an up-to-date cache absorbs as no-ops. Idempotent, and
proven end-to-end in `invariant.ts`: an offline revocation heals at reconnect.

---

## 12. Cells — one DB per workspace, elastic processes

The deployment shape: a **cell** is one workspace's entire backend — a TripleServer
plus its own storage file, own log, own versions, own epoch. `createCellHost` routes
`/w/<workspace>/api/*` to lazily-created cells, so one Node process hosts many
workspaces; a hot workspace is promoted by moving its file to its own process at the
router above.

Invariants: workspace↔DB is 1:1 forever; exactly ONE process owns a workspace at a
time (the log's single-writer guarantee). A mega-workspace scales by log-fed read
processes (§3, §7), never by splitting its DB. Cross-workspace features are built by
shipping every cell's identical log into one warehouse stream, not by cross-cell
queries. Membership auth belongs in the host's `resolveActor(req, workspace)`.

---

## 13. Multiplayer, offline, presence

One rule organizes all three: **durable facts ride the log; transient state rides
beside it, unlogged.**

**Presence** — distinct actors with an open stream. The roster travels once per
stream (immediately after `hello`, which is always first); every change after that
is an O(1) `joined`/`left` diff. Derived from the subscriber registry the fan-out
already keeps; never stored anywhere.

**Multiplayer** — the fast path is `broadcast(payload, { about?, key? })`:
ephemeral messages on the same stream, never logged, never versioned, lossy by
design. The pattern is *preview ephemerally, commit on settle*: a drag streams
frames to every peer and writes ONE log entry when it ends. Guard rails: payloads
cap at 16KB (fan-out amplification); the client coalesces per `key` to ≤30
sends/sec, latest wins; and `about: subjectId` scopes delivery to subscribers whose
READ policy admits that subject — transient activity honors the same visibility as
the data it concerns. Concurrent commits to one single-valued field resolve
last-write-wins (§9.1); character-merging text needs a CRDT value type (§11.1).

**Offline** — three pieces, two of them already existed:

- *Reads*: the cache answers watched queries synchronously; with `persistence`
  (a sync `load`/`save` string store — `localStorage`, a file) the cache, cursor,
  epoch and outbox survive reloads. A cold offline boot renders instantly from
  disk. Saves are dirty-checked and debounced (~345KB per 10k triples; localStorage
  holds roughly 100k). Across a schema deploy the CACHE is discarded — but the
  outbox is not: entries whose intent still compiles carry over; the rest surface
  through `onRejected`, never silently. `transact` reports `"committed"` or
  `"queued"` so the app can tell the difference.
- *Writes*: a network failure moves the batch — as INTENT, not deltas — into a
  durable outbox and resolves; the optimistic layer stays visible. On reconnect the
  outbox drains serially ahead of any new writes. Intent is what makes the queue
  correct after days offline: the server compiles it against present truth on
  arrival (§9.1). Late rejections surface through `onRejected`.
- *Reconciliation*: nothing new — the cursor, epoch and resync machinery (§7.3)
  already handle every way a returning client can be behind.

### 10.7 The declarative fork — built, measured, and removed

Rules here are lambdas, and ONLY lambdas — that is a decision, not a default,
and it was made the expensive way. An expression form (`{ path: ["team",
"member"] }`-style rules as data) was fully built on this codebase: typed
paths, self-deriving `fields`, and read rules compiling to visible-subject sets
through the POS index. Measured at 100k todos, it eliminated verdict cost —
about 35% end to end on adversarial 10k-candidate scans (40→26ms memory,
99→64ms sqlite) — and touched nothing on realistic windowed reads, which were
already fast. Then it was removed. Two reasons:

1. **Two ways to say one thing.** Every rule was writable both ways, the
   readable way (an arrow that reads as a sentence) and the analyzable way (an
   AST you decode). Codebases would mix them, and every mixed codebase loses
   both properties at once.
2. **The real wins demand all-or-nothing.** What expressions ultimately buy —
   policy as scan constraints, audience-partitioned fan-out, CDN-cacheable
   reads — only materializes when EVERY rule is analyzable. That is why the
   systems that cash those wins allow nothing else: Zero's permissions and
   Electric's shapes are declarative-only. One lambda anywhere and the
   guarantee is gone. A system that wants those properties should make
   expressions its only rule language from day one — a different system than
   this one, now with its cost and payoff measured.

So: one way, full reach, `fields` declared explicitly (the declaration is also
what live revocation's dependency map reads, §10.6 — that never needed
expressions). The fork stands documented for the day a deployment's scale
argues the other side.

---

## 11. Deferred

The working rule: if nothing reads it, it does not exist. Anything speculative gets
described here instead of sitting half-built in the source, so that every line in
`src/` is load-bearing and the spec carries the intent.

### 11.1 Not built

Additive later, deliberately absent now:

| Deferred | Why it's safe to skip |
|---|---|
| Blank nodes | Unmergeable across peers; client-minted ids replace them (§0.4) |
| **Named graphs / 4th position** | Log carries provenance (§3.1) — *has a migration cost* |
| IRI resolution, CURIEs, base URIs | Predicates are plain namespaced strings |
| `xsd:` datatypes | `typeof` is enough until we serialize to standard RDF |
| N-Quads / Turtle / JSON-LD | JSON over the wire; codecs are pure functions, bolt on anytime |
| RDFS entailment | No `subClassOf` in the demo domain |
| ~~SHACL validation~~ | Superseded in spirit: every write is validated against the declared type — scalars, unions, and object shapes recursively (§4.7). What remains un-built is cross-field constraint LOGIC, which is what policies' write rules are for |
| SPARQL | Typed pattern arrays instead (§6) |
| Query planning / constraint reordering | Actor controls order and that is a stated decision (§6.2). A planner needs cardinality estimates, and would silently undo a deliberate ordering |
| ~~Reverse traversal~~ | **Built** (§6.8) as correlated subqueries: `.select((team) => ({ todos: Query.from(Todo).where("team", team)… }))` — explicit correlation, per-parent filters/windows, live |
| ~~Disjunction, negation, ranges in `where`~~ | **Built** (§6.9–§6.10): array-`where` (IN), `whereNot`/`whereAbsent` (refinement-only, with shipped negation evidence for partial-cache soundness), `whereGreater(OrEqual)`/`whereLesser(OrEqual)`/`whereBetween` on the order-preserving encoding, and `whereEither` for OR across conditions. SPARQL-style OPTIONAL never needed a feature: selections already tolerate absence (§4.5) |
| Ordering and pagination of results | Callers sort in JS; the store is a set with no inherent order (§0.1) |
| Incremental view maintenance | Re-run on predicate intersection (§6.1) |
| CRDTs / vector clocks | Server-authoritative (§7.2) |
| ~~Log compaction policy~~ | **Built**: `retainLog: N` on the server — once per N commits, entries older than the last N are forgotten (deterministic in version, so restarts change nothing). The store IS the snapshot, so nothing needs persisting; stale cursors resync from state. Proven in `invariant.ts` on both adapters |
| ~~Mutually-referencing entities~~ | **Built** (§4.4): `Schema.ref(() => B)` thunks resolve lazily; type aliases break the type cycle. Acyclic schemas keep full inference |
| ~~Per-field write overrides~~ | **Built** (§10.4): `overrides: { field: { write } }` replaces the entity create/update rule for that field's changes (delete stays entity-level). Precedence: replace, mirroring read overrides |
| ~~Query by subject id~~ | **Built** (§6.7): `Query.from(Todo).whereId("todo_1")` pins the root set to one known subject; constraints still filter it, prefix mismatches throw eagerly, and an invisible subject is indistinguishable from an absent one |
| ~~Async storage adapters~~ | **Settled by design** (§5.4): reads never go async — a cell's working set lives in memory/sqlite; Postgres joins as write-through durability behind the log (sync local commit, backpressured flush, boot-time fold). IndexedDB client persistence remains a straightforward `ClientPersistence` impl |
| Batched match for SQL adapters | The executor issues one `match()` per subject per predicate — N+1 against SQL. The 3× query gap at 60k triples is mostly this; a set-based `matchMany` would close it |
| ~~Range-seed pushdown~~ | **Built** (`matchRange`): the encoded `object` column compares in value order, so a range seed is an index range read on `idx_po` — measured 56.7 → 2.0ms at 100k triples. Memory falls back to the scan (23ms — acceptable) |
| ~~Batched subquery collection~~ | **Built** for the correlate-only shape (one shared level walk over all parents) — and measured HONESTLY: ~neutral at 200 parents (13.8 vs 14.5ms memory, 51 vs 48ms sqlite), because the policy-context cache was already shared across recursions and per-parent lookups are indexed. It will matter for adapters with real per-statement latency; the per-parent path stays for every other shape |
| ~~Declarative policy expressions~~ | **Built, measured, REMOVED** (§10.7): ~35% on adversarial scans, ~0% on realistic reads, and two rule languages where one suffices. The real declarative wins (scan constraints, audience fan-out, CDN) demand declarative-ONLY — a different system, documented with its price |
| Policy pushdown into the query | Requires the declarative-only fork §10.7 declined: lambdas cannot become scan constraints. The measured prototype showed what it buys; taking it means a one-language policy system from day one |
| ~~Offline queue / mutation persistence~~ | **Built** (§13): the outbox persists intent through `ClientPersistence`, drains on reconnect in order, carries over across compatible schema deploys, and surfaces the rest via `onRejected` |
| ~~Cache eviction~~ | **Built** (§7.6): every `close()` re-collects each surviving query's triples against the local view (the server's own collector) and drops the rest — the cache is bounded by what is WATCHED. Pushes for unwatched data regrow it only until the next close; `client.evict()` sweeps manually |
| ~~Partial replication~~ | Built (§7.5): `pull()` shipped the whole store. A watched query now ships only what it needs, filtered by the policy (§10.5) |
| ~~Permission-change visibility diffs~~ | **Built** (§10.6): context-derived dependency map + per-subscriber diffs, plus the epoch for policy deploys |
| ~~Visibility-diff fan-out cost~~ | **Fixed** (goal v1): shared per-subject triple diffs + per-actor memoized verdicts — the same 500-todo/500-subscriber revocation went 2552ms → ~22ms |
| ~~Visibility diffs on catch-up~~ | **Built** (`repair`, §10.6): after the backlog, the server walks its policy-relevant subjects once — now-invisible ones are EVICTED BY ID (never by value, so nothing leaks to an actor who never saw it), still-visible ones get their current readable triples re-sent (idempotent no-ops for an up-to-date cache). Proven end-to-end in `invariant.ts`: offline revocation heals at reconnect |
| `ctx.read` opts out of live revocation | Imperative reads are invisible to the dependency map (§10.6) — one more reason to declare `fields` |
| Schema migrations | Schema is a literal in source |
| ~~Framework bindings~~ | **Built** (`createHooks(client)` → `useQuery`/`usePresence`): watch stays the visible primitive; the hook owns only the lifecycle (mount→watch, unmount→close→evict). Query identity = the reference, under React's own rule (stable, or the callback form with deps — mirroring `useMemo`). Proven on real React 19 + StrictMode: cache-first paint, live re-render, unmount evicts (`npm run hooks`) |
| Codegen from schema | Hand-written types |

### 11.2 Cut, and what would bring them back

Written once, then removed because nothing consumed them. Each is a real idea; none
earns its keep yet.

| Cut | What it was for | What would bring it back |
|---|---|---|
| `inverse` schema field | Naming the backward read of a ref — `user.todos` resolving to a reverse traversal of `todo/owner` | The entity layer (§9) or query engine (§6) offering relationship names. It names a **read**, never a second predicate to write (§4.3) |
| `user/todos` predicate | A stored back-edge from user to todo | A relationship that is not ownership read backwards — "starred todos", say. Plain inverses stay the index's job |
| ~~`subscribe` / `delta` message types~~ | The realtime half of the protocol | **Built** (§7.7): SSE stream + per-subscriber filtered fan-out |
| `Store.has(triple)` | Existence check without allocating a result array | A hot path where `match(...).length > 0` shows up in a profile |
| `valuesEqual` / `triplesEqual` | Structural comparison of terms | Something that must compare without building a key string. `tripleKey` covers every current need |
| `EMPTY_DELTA` | A shared empty-delta constant | Nothing — inline `{ added: [], removed: [] }` reads fine and cannot be mutated by accident |
| ~~Typed ref targets~~ | `Schema.ref("user")`, so a ref knows what it points at | **Built** (§4): entities arrived, and `Schema.ref(User)` carries its target in the type |

### 11.3 Known gaps in what IS built

None. The last one — `tx.delete` blind to inbound refs outside the client's cache —
closed when `delete` became a wire-level intent the server compiles authoritatively
(§9.1).

### 11.4 Design debt

Not missing features — places where the DESIGN itself should change. Ranked.

| Debt | The flaw | The fix |
|---|---|---|
| ~~Wire carries materialized deltas, not intent~~ **Fixed** (§9.1) | The client compiles "set text" into remove+add; the server distrusts and re-derives it (§9.1); delete intent is lost entirely (§11.3); double-set needs a bespoke rejection. Three patches for one missing abstraction | The wire carries OPERATIONS (`set`/`add`/`remove`/`delete`); the log keeps materialized deltas. Datomic's split: transaction data in, tx-report out |
| ~~Subjects have no type~~ **Fixed** (§4.6) | Entity membership is emergent from predicate namespaces — `note/body` lands on a user subject with an ack. Verb derivation, §4.5 grouping, and delete semantics all infer per predicate group; `whereId` cannot exist cleanly | Declare the type at create (a type triple, or an enforced id convention) and check every write against it |
| ~~Schema freeze vs expand/contract~~ **Fixed** (`compatibleSchemas`, §7.3) | ANY schema change freezes every old client instantly — so the "keep `text` for old clients" phase can never serve anyone. §7.3 and the migration playbook contradict | A compatibility hash: freeze only on breaking changes (removals, retypes, required-flips); additive-optional keeps the hash. Or embrace hard-freeze and delete the dual-write doctrine |
| ~~Fan-out is compute-per-subscriber~~ **Fixed**: shared contexts + subject diffs, memoized per actor — revocation 2552ms → ~35ms | The §11.1 revocation cliff is a symptom: the per-subject diff is shared work, only the verdict differs per actor | Classify once — audiences / dirty-sets — then map subscribers to audiences |
| ~~Chatty executor data access~~ **Fixed**: `matchSubjects` + level-order walk + context preload; and `version` no longer derived via full snapshot — sqlite query 42→8ms, memory 15→4ms | One `match()` per subject per predicate (N+1). The sync adapter interface is not the Postgres blocker; this is | Set-based `matchMany` first; the async refactor becomes small instead of viral |
| ~~The core thesis is untested~~ **Fixed**: `npm run invariant` — 400 random ops, fold(log) === state, both adapters | `state = fold(log)` is claimed everywhere, verified nowhere | An invariant test: rebuild a store by replaying the log above the floor, assert equality with the live store |
| ~~Stream lifecycle seams~~ **Fixed**: bounded SSE buffer (drop + log replay), ping-interval session revalidation, schema gate in server core | `res.write` backpressure ignored (a slow client buffers unboundedly); no session revalidation over a stream's lifetime; the schema gate lives in http.ts so in-process callers bypass it | Honor `write()` returns; a `revalidate(actor)` hook; move the gate into TripleServer |
| ~~Client change detection~~ **Fixed**: per-row fingerprints with stable object identity for unchanged rows | JSON fingerprint is O(result) per touched delta and every re-run mints new row identities — a React binding would re-render every row | Keyed row reuse + per-row versions before framework bindings |
