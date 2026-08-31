# Querying — find, shape, and stay current

A query does three jobs with one object: it declares what to FIND (`where*`),
what SHAPE to return (`select`), and — through `watch`/`useQuery` — what to keep
CURRENT. The same query is also the unit of sync: the server ships exactly the
triples it needs, filtered per reader, nothing more (§7.5).

```ts
const q = Query.from(Todo)
  .where("owner", { id: me })          // ordered — you are the planner (§6.2)
  .whereNot("completed", true)
  .orderBy("text").limit(50)           // a live WINDOW, keyset-cursored
  .select((todo) => ({
    text: true,
    owner: { name: true },             // follow the ref — typed by the target
    comments: Query.from(Comment)      // correlated subquery: the join
      .where("todo", todo)
      .orderBy("at").limit(3)
      .select({ body: true }),
  }));
```

## Finding — the where family

One rule holds the family together: chained constraints are ANDs, run in YOUR
order, each filtering what survived the last. There is no planner; the most
selective constraint belongs first.

| method | meaning |
|---|---|
| `where(field, value)` | holds exactly this value |
| `where(field, [a, b])` | holds ANY of these (the IN — unambiguous: no field ever holds an array) |
| `whereId(id)` | pin to one known subject; prefix-checked eagerly |
| `whereNot / whereAbsent` | negations — REFINE only, never seed (you cannot scan for what is missing, §0.3) |
| `whereGreater(OrEqual) / whereLesser(OrEqual) / whereBetween` | ranges on the order-preserving encoding |
| `whereEither(b1, b2)` | OR across different conditions; may seed (union of branches) |

Negations stay sound on a partial client cache because the server ships
**negation evidence** — the negated predicate's readable triples for every
candidate — so the client judges from evidence, never from what its cache
happens to lack (§6.9).

## Shaping — select is a mirror

The select tree IS the result type: bare field names, refs nesting into their
target, `ResultOf<typeof q>` computing the row type. Unknown keys hold
correlated subqueries — ordinary queries whose `.where(field, row)` pins a ref
to the row being built, at any depth, each level's callback receiving its own
handle. Windows, filters and order apply PER PARENT — the join alternatives
(N+1 client-side stitching) cannot say that.

## Staying current

`watch` (or [`useQuery`](../README.md)) keeps results live: a delta re-runs only
the queries whose predicate set it intersects (0.01ms per re-run at 1k rows),
and unchanged rows keep `===` identity so keyed UIs re-render one row. Windows
maintain themselves: rows push in, and when rows fall out the query refetches
exactly when the cache cannot know what comes next. `live.cursor` hands you the
next page for `.after(cursor)`.

## Performance — measured, and where it comes from

Cost tracks the CANDIDATE set and the result — never total store size — except
seeds that scan. At 100k todos, full policy on:

|  | memory | sqlite | why |
|---|---|---|---|
| whereId · windowed 50 · refinements | ≤0.3ms | ≤1ms | O(result): POS/`topSubjects` index paths |
| equality seed → 1k roots | 1.8ms | 4.0ms | O(candidates) |
| negations / ranges as refinements | ≤1.9ms | ≤5.4ms | batched, one read per constraint |
| range as the SEED | 23ms | 2.0ms | sqlite: index range read (`matchRange`); memory scans |
| 10k-candidate scan | 9.7ms | 30ms | policy verdicts dominate — selectivity is your lever |
| join, 20 windowed parents | 1.1ms | — | windowed parents keep recursion small |

Two structural facts explain the table: every operator maps onto an index the
store already has (SPO, POS, and the encoded-object order), and policy filters
INSIDE the scan — an invisible row costs a check, never a leak (§10.5).

Deep dive: SPEC §6 (all of it), §11.4.
