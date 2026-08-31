# Presence — who is here, and the unlogged lane

Presence answers "who is connected right now" without ever touching the log:
being online is not a fact about the domain, it is a fact about the connection.

## The roster and its diffs

On subscribe, a client receives the full roster ONCE; from then on, everyone
gets O(1) diffs — `{ joined: actor }` when an actor's FIRST connection opens,
`{ left: actor }` when their LAST one closes (two tabs are one presence). The
client folds these into `client.presence`, and notifies:

```ts
client.onPresence((online) => render(online));   // vanilla
const online = usePresence();                     // React — same source
```

Ordering matters and is guaranteed: `hello` first, then the roster, then join
diffs — a client never has to interpret a diff against a roster it has not
seen ([realtime](./realtime.md)).

## Ephemeral broadcast — presence's richer sibling

Cursors, selections, typing indicators, drag previews: real multiplayer state
that would poison an append-only log. `broadcast` is the second lane:

```ts
client.broadcast({ cursor: [x, y] });                    // to everyone here
client.broadcast({ dragging: rect }, { about: todoId }); // visibility-scoped
client.onEphemeral((actor, payload) => { ... });
```

- **Unlogged** — no version, no history, no replay. Miss it and it is gone,
  which is exactly right for a cursor.
- **Coalesced** — ~33ms window per key keeps the latest payload only: 60 drag
  frames/second reach peers as ~30 messages and zero log entries. When the drag
  settles, ONE transact records where it landed — the durable fact.
- **Capped** at 16KB — the lane is for signals, not payloads.
- **`about:` scoping** runs the entity's read policy (`canSeeSubject`): peers
  who may not see the todo never learn someone is dragging it. Presence honors
  the same visibility rules as data (§13).

The dividing rule, worth internalizing: **if it should survive a refresh, it is
a triple; if it should die with the tab, it is a broadcast.**

Deep dive: SPEC §13.
