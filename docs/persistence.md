# Persistence — what survives a restart, on each side

Two different questions share this word: what survives a **server** restart, and
what survives a **client** reload. Both answers come from the same design: the
log is the truth, everything else is a fold of it.

## Server durability

Hand the server a `SqliteStorage` and durability is total:

```ts
new TripleServer({ schema, policy, storage: new SqliteStorage(".data/app.db") })
```

Store and log commit in one SQL transaction ([adapters](./adapters.md)); the
epoch is persisted with the data because it IS part of the data's identity —
a fresh database is a new epoch, and clients notice ([recovery](./recovery.md)).
After a restart, connected clients reconnect with their version cursor and the
log replays exactly what they missed. Measured: ~500 bytes per triple in memory,
143ms to seed 60k triples, intact across reopen (`npm run bench`).

## Client persistence

The client takes any synchronous string store:

```ts
new TripleClient({
  schema,
  transport,
  persistence: {
    load: () => localStorage.getItem("app"),
    save: (state) => localStorage.setItem("app", state),
  },
})
```

What is saved — debounced ~100ms behind a cheap dirty-check, ~345KB per 10k
triples:

| field | why it is there |
|---|---|
| `triples` | the confirmed cache — cold boots render BEFORE the network answers |
| `version` | the sync cursor — reconnect replays only what was missed |
| `outbox` | queued intent — writes made offline survive the reload and drain in order |
| `schema` | the generation this cache was built by — a mismatch freezes instead of corrupting ([migration](./migration.md)) |
| `epoch` | which history this cache belongs to — a different server epoch forces resync |

Two properties worth naming:

- **Pending optimistic layers are deliberately NOT saved** — only confirmed
  state and durable *intent*. A reload replays intent through the same outbox
  path as a reconnect; previews are recomputed, never trusted from disk.
- **The cache is bounded by what is watched** (§7.6): closing a query evicts
  the triples nothing else needs, so persistence size tracks your open queries,
  not your session length.

Deep dive: SPEC §7.6, §13.
