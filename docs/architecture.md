# Architecture — cells, adoption, layout

Built for **one DB per workspace, one process for many workspaces**:

```
router ──► process ──► cell = TripleServer + workspace.db   (× many per process)
```

- A **cell** is a workspace's whole backend: its own data, log, versions, epoch.
- **Workspace ↔ DB is 1:1 forever**; processes are the elastic layer — busy
  workspaces get their own, small ones share.
- One process owns a workspace at a time (the log's single-writer rule). A huge
  workspace adds log-fed read processes; a DB is never split.
- **Realtime and data belong in the same worker**: fan-out is computed at commit
  time against pre/post state — that is what makes permission-filtered push and
  revocation-as-delta possible. Separate them and you recreate the dual-write
  problem between two services.
- Global features (search, analytics) come from shipping every cell's log into one
  stream — not cross-cell queries.

```ts
const host = createCellHost({
  createCell: (ws) =>
    new TripleServer({
      schema,
      policy,
      storage: new SqliteStorage(`data/${ws}.db`),
    }),
  resolveActor: (req, ws) => authenticate(req, ws), // membership check lives here
});
// client: the workspace is just the base URL — new HttpTransport(`/w/${ws}/api`)
```

The measurements below are **per workspace** (~5k users, millions of triples per
cell). A single-tenant app skips this and uses one `TripleServer`, like the demo.

Greenfield is a privilege; the ideas transfer incrementally. The order that works —
each step is independently valuable and reversible:

1. **Introduce the log** — every write also appends `{version, actor, delta}`.
   Nothing reads it yet. This is the spine everything else hangs off.
2. **Move reads to stamped queries** — responses carry the version they were
   computed at; clients gain a cursor. Catch-up and reconnect fall out.
3. **Fan out from the log** — realtime becomes "the commit, forwarded", replacing
   any separate notification path. This is where room and data naturally merge.
4. **Move permissions server-side, into the scan** — one rule set per entity,
   filtering before data leaves. The most valuable and most-postponed step.
5. **One worker per workspace** — by now the worker is self-contained, so the cell
   split is an ops change, not a rewrite.

The trap to avoid at every step: two sources of truth for the same fact (state
written here, history written there). Every mechanism in this repo assumes a write
lands in state and log atomically — that invariant is cheap on day one and nearly
impossible to retrofit.

```
src/sdk/shared/   types · store · log · schema · query · transaction · protocol
src/sdk/server/   server · http (SSE) · policy · sqlite · cells (workspace host)
src/sdk/client/   client (watch/transact/connect) · transport
src/demo/         the todos & teams app: shared/schema · server/policy · client
```

Start with `src/sdk/shared/types.ts` — the whole vocabulary is five types.
