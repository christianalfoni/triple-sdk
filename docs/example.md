# The example — todos & teams

The complete worked example the demo runs — schema, policy, server, client,
React — followed by what the compiler catches.

**Shape** — one shared file, imported by both sides:

```ts
export const User = Schema.from({ name: Schema.string() });
export const Team = Schema.from({
  name: Schema.string(),
  member: Schema.ref(User).multiple(),
});
export const Todo = Schema.from({
  text: Schema.string(), // required by default  → `string`
  completed: Schema.boolean(),
  owner: Schema.ref(User), // a ref knows its target
  team: Schema.ref(Team).optional(), //                      → `Ref | undefined`
  tags: Schema.string().multiple(), //                      → `string[]`
});
// an entity is just its fields — the KEY here is its name (and its id prefix)
export const schema = Schema.build({ user: User, team: Team, todo: Todo });
```

**Policy** — server-only. One block per entity, four verbs, checks written inline
(`(ctx) => boolean | undefined`, where only an explicit `true` grants — so optional
chains need no `?? false`; the SDK ships no checks). `fields` declares what the rules get to
SEE: a selection (same form as a query's `select`), traversing refs — declared as
data, so the engine loads it once per subject, can batch it, and knows which
writes change whose visibility:

```ts
export const todoPolicy = Policy.from(Todo, {
  fields: { owner: true, team: { member: true } },
  read: (ctx) =>
    ctx.fields.owner?.id === ctx.actor ||
    ctx.fields.team?.member.some((m) => m.id === ctx.actor),
  create: (ctx) => ctx.fields.owner?.id === ctx.actor, // fields = ONCE IT LANDS
  update: (ctx) => ctx.fields.owner?.id === ctx.actor, // fields = as it is now
  delete: (ctx) => ctx.fields.owner?.id === ctx.actor, // (update alone also gets ctx.after)
});
// one standalone policy per entity; Policy.build assembles them — same
// from/build pairing as the schema side:
export const policy = Policy.build(schema, {
  user: userPolicy,
  team: teamPolicy,
  todo: todoPolicy, // omit ONE → "Property 'todo' is missing" — deny-by-default
});
```

**Server** — identity comes from the authenticated connection, never the message:

```ts
const server = new TripleServer({
  schema, // the shared shape
  policy, // the server-only rules, built FROM that schema
  storage: new SqliteStorage(".data/app.db"), // omit → in-memory
});
createServer(createHttpHandler(server, resolveActor)).listen(3000);
```

**Client** — `watch` is the only read; `connect` makes it live:

```ts
const client = new TripleClient({
  entities,
  transport: new HttpTransport("/api"),
});
client.connect(); // SSE push · auto-reconnect · epoch + schema handshakes

const todos = client.watch(
  Query.from(Todo)
    .where("owner", { id: me }) // ordered constraints — you are the planner
    .select({ text: true, completed: true, owner: { name: true } }),
);
todos.subscribe(render); // .data · .status · .ready · .close()
```

**React** — `watch` is the primitive; `useQuery` is how a component consumes it
(mount→watch, change→re-render, unmount→close, which also lets the cache evict).
Query identity is the reference, under React's own rule — stable, or memoized
with deps — so the two call shapes mirror `useMemo`. The demo app runs on it:

```tsx
const { useQuery, usePresence } = createHooks(client); // once, next to the client

function Todos() {
  const todos = useQuery(myTodos); // stable reference, defined outside
  return <ul>{todos.data.map((t) => <li key={t.id}>{t.text}</li>)}</ul>;
}

function UserTodos({ userId }: { userId: string }) {
  const todos = useQuery(
    () => Query.from(Todo).where("owner", { id: userId }).select({ text: true }),
    [userId], // deps decide when this becomes a NEW query
  );
  return <ul>{todos.data.map((t) => <li key={t.id}>{t.text}</li>)}</ul>;
}

await client.transact((tx) => {
  tx.create(Todo, {                       // id minted on the client (§8.4);
    text: "ship it",                      // visible BEFORE the network is touched
    completed: false,                     // required fields REQUIRED — forget one
    owner: { id: me },                    // and it does not compile
  });
  tx.edit(Todo, otherId).completed = true; // property write → set intent
});
```

The row type is computed from the entity, never written by hand — and required means
required, because the server rejects any write that would leave a surviving subject
without it:

```ts
type Row = ResultOf<typeof todos>;
// { id: string; text: string; completed: boolean;
//   owner: { id: string; name: string } }
```

Mistakes are compile errors, pinned in the two `*.type-test.ts` files:

```ts
Query.from(Todo).where("nope", 1); // unknown field
Query.from(Todo).where("completed", "yes"); // boolean, not string
tx.create(Todo, { text: "x", owner: { id: me } }); // `completed` missing — required
tx.edit(Todo, id).text = undefined; // required fields cannot be cleared
tx.edit(Todo, id).tags = ["a"]; // lists are mutated (push/remove), never reassigned
Policy.build(schema, { user: userPolicy, team: teamPolicy });
// ^ Property 'todo' is missing — every entity's policy is a required key.
Policy.from(Todo, {
  fields: { owner: true },
  read: (ctx) => ctx.fields.team !== undefined,
}); // the declared fields don't include `team`
```
