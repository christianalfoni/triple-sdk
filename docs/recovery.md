# Recovery — every way to be behind, and its healing

The design goal: **"behind" is always one number**, and what the number cannot
heal, coarser identities catch. A client's entire sync state is a version
cursor; above it sit the epoch (which history?) and the schema hash (which
code?). Every failure mode maps to exactly one rung:

| how far behind | detected by | healed by |
|---|---|---|
| in-flight races, redelivery | version cursor | skip — idempotent |
| disconnected minutes/days | `?since=cursor` on reconnect | log replay, filtered per reader |
| missed a permission change while away | server, from the backlog | `repair`: evict by id, refresh by value |
| cursor predates retained log | `entriesSince → null` | `resync`: drop cache, re-query state |
| different history (new DB, policy deploy) | `hello.epoch` mismatch | resync |
| old client code | schema hash not accepted | **freeze**: reads/writes throw `outdated`, human refreshes |

Three of these deserve their mechanics spelled out:

**Backlog replay** is the log doing its job: `entriesSince(cursor)`, each
entry's delta filtered for this reader, versions advancing the cursor. The
*snapshot-meets-cursor* rule keeps replay and query responses composable: a
query answer is only applied when its snapshot version is at or beyond the
stream's cursor, so a refresh can never resurrect a removal the stream already
delivered.

**Repair** (§10.6) closes the subtle hole: the backlog is filtered by CURRENT
readability, so the entry that revoked your access may itself be invisible to
you — you would keep stale rows forever. After the backlog, the server walks the
backlog's policy-relevant subjects once: now-invisible ones are **evicted by
id** (never by value — an actor who never saw a triple learns nothing from its
eviction), still-visible ones get their current readable triples re-sent, which
an up-to-date cache absorbs as no-ops. Idempotent; proven end-to-end in
`invariant.ts` (offline revocation heals at reconnect).

**The offline outbox** recovers the WRITE side. Writes made offline queue as
intent (`"queued"`), survive reloads ([persistence](./persistence.md)), and
drain in order on reconnect. Because intent is compiled against the server's
truth on arrival (§9.1), a days-old queue is still correct; if the schema
changed meanwhile, entries that still compile carry over, and the rest surface
through `onRejected` — never silently dropped.

The through-line: recovery never has a special path. Replay is the same fold as
normal operation; resync is the same query path as first load; repair is the
same visibility machinery as live revocation. One model, reused.

Deep dive: SPEC §7.3, §8.2, §10.6, §13.
