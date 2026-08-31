# Goal: best-in-scope — CLEARED

No new features. Resolve every §11.4 design-debt item, close the last §11.3 gap,
prove the core thesis, and hit hard performance targets. Verified by
`npm run typecheck` + `npm run smoke` (both adapters) + `npm run bench` + `npm run invariant`.

| #   | Metric                                        | Baseline            | Target                 | Result             |
| --- | --------------------------------------------- | ------------------- | ---------------------- | ------------------ |
| G1  | `state = fold(log)` invariant test            | not tested          | passing, both adapters | ✅ 400 ops, both    |
| G2  | Revocation event (500-todo team, 500 subs)    | 2552ms              | < 50ms                 | ✅ ~25–47ms (≈75×)  |
| G3  | Write fan-out @ 500 subscribers               | 1.3ms               | < 0.5ms                | ✅ 0.1ms            |
| G4  | SQLite query, 1k todos policy-filtered        | 42.1ms              | < 15ms                 | ✅ 8.8ms            |
| G5  | Memory query, 1k todos policy-filtered        | 15.0ms              | < 8ms                  | ✅ 4.3ms            |
| G6  | Wire carries intent (set/add/remove/delete)   | compiled deltas     | operations             | ✅ §9.1             |
| G7  | §11.3 gaps (client-blind delete refs)         | 1                   | 0                      | ✅ delete compiles server-side |
| G8  | Cross-entity triple write                     | accepted            | rejected               | ✅ eager + authoritative |
| G9  | Additive schema deploy                        | freezes old clients | compatible via opt-in  | ✅ `compatibleSchemas` |
| G10 | Row identity across live-query re-runs        | new objects always  | stable when unchanged  | ✅ per-row fingerprints |
| G11 | Smoke steps, green on BOTH adapters           | 20                  | ≥ 23                   | ✅ 23 + 23          |
| G12 | Slow-subscriber SSE buffer                    | unbounded           | bounded, drop + replay | ✅ 1MB cap + heartbeat revalidation |
| G13 | §11.4 design-debt items open                  | 8                   | 0                      | ✅ all struck       |

Surprise findings along the way: `storage.snapshot()` was being called just to read
the version — on every query, no-op ack, AND stream open — fetching all 60k triples
each time; and setting a field to its current value used to burn a log version
(cancelling op-compile made it a true no-op).

# Goal card v2: multiplayer/offline/presence hardening — CLEARED

| #   | Metric                          | Baseline → Result                                                        |
| --- | ------------------------------- | ------------------------------------------------------------------------ |
| G14 | Outbox across a schema deploy   | silently lost → **carried when compilable; surfaced via onRejected, never silent** |
| G15 | Stream contract                 | presence-before-hello → **hello always first**, verified                 |
| G16 | Broadcast safety                | unbounded → **16KB cap (413)** + coalescing: 60 calls/tick → 1 send      |
| G17 | Ephemeral visibility            | leaked to all → **`about:` filters by read policy** — private-drag withheld, team-drag delivered |
| G18 | Presence churn                  | O(online²) rosters → **roster once on hello, O(1) join/left diffs**      |
| G19 | Persistence bounds              | unmeasured → **345KB per 10k triples, dirty-check: 0 saves when unchanged** (localStorage fits ~100k triples) |
| G20 | `transact` outcome              | `void` → **`"committed" \| "queued"`**, verified both paths              |
| G21 | Hygiene + coverage              | timers `unref`'d · **smoke 26/26 on both adapters** · invariant green    |

# Goal card v3: pagination performance — CLEARED

Windowed query, 50 of 10k policy-filtered roots over a 600k-triple store:

| Adapter | Baseline | Result | How |
| ------- | -------- | ------ | --- |
| memory  | 37.2ms   | **4.5ms** (8×)  | order-preserving number encoding → rank on encoded strings; bounded top-K; deferred policy — check window batches, not all candidates |
| sqlite  | 62.5ms (then a planner hang) | **11.6ms** (5×) | same, plus `json_each` cached statements (prepare was 95% of chunked cost) and `CROSS JOIN` to pin the join order |

Small windows (1k roots): memory 1.9 → 0.6ms, sqlite 5.7 → 1.4ms. Equivalence
proven: 16/16 randomized window/cursor/direction cases against a naive oracle, and
fast path === general path under a policy hiding 35% of rows. Windows agree across
adapters. Deferred-policy §10.5 argument: invisible rows are skipped, never counted
— the checks saved are for rows the window would never include.
