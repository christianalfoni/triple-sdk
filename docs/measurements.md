# Measurements

`npm run bench` — in-process, so the numbers are the SDK's cost, not the network's
(M-series laptop, 60k triples, 20 users, full policy on):

```
                                    memory    sqlite (durable)
query, 1k rows policy-filtered      5.6ms     7.0ms
query, ordered window of 50         0.6ms     1.4ms
write (3-triple transact)           0.05ms    0.13ms
seed 60k triples                    21ms      143ms · survives restart ✓
```

```
fan-out   write → 500 subscribers 0.1ms · revocation on a 500-todo team ~22ms
client    1k-row live query re-runs per delta in 0.01ms, stable row identity
windows   50 of 10k policy-filtered roots on a 600k store: 4.5ms mem / 11.6ms sqlite
```

**Query-engine scaling** (100k todos, policy on) — cost tracks the CANDIDATE set
and the result, never total store size, except scan seeds:

```
                                       memory    sqlite
whereId · windowed 50 · refinements    ≤0.3ms    ≤1ms      O(result)
equality seed → 1k roots               1.8ms     4.0ms     O(candidates)
negation / absence / range refine      ≤1.9ms    ≤5.4ms    batched, same as positives
set-form seed → 10k candidates         14ms      37ms      policy checks dominate
range as the SEED at 100k              23ms      2.0ms     sqlite: index range read (was 57ms)
whereEither                            +~15% over its dominant branch — the OR is free
```

**Capacity envelope** — one Node process, full policy, measured:

|                                |                                                                           |
| ------------------------------ | ------------------------------------------------------------------------- |
| Memory cost                    | ~500 B/triple → ~2M triples per GB heap; SQLite is disk-bound beyond that |
| Sustained writes, fan-out live | ~5,000/sec @ 500 subscribers · ~3,500/sec @ 5,000                         |
| Cold hydrations                | ~500/sec full 1k-row · ~3,000/sec windowed 50-row                         |
| Client persistence             | ~345KB per 10k triples (localStorage holds ~100k)                         |

With real-app assumptions (active users write 0.1–0.5 ops/sec, hydrate windowed on
open), **one process serves ~5,000 concurrent users on millions of triples** — and
under the cells architecture that envelope is _per workspace_, which almost no
single organization exceeds. The remaining ceilings and their designed fixes live
in SPEC §11: policy pushdown for O(visible) reads, audience logs for CDN-scale
fan-out, log-fed read processes for a mega-workspace. `GOALS.md` records the three
measured burn-downs that produced these numbers (revocation 2552→22ms, sqlite
windows 62→12ms, queries 42→7ms).
