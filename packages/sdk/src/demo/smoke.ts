/**
 * A headless walk through the SDK. Run with the demo server up:
 *
 *   npm run dev:server      # terminal 1
 *   npm run smoke           # terminal 2
 */

import { HttpTransport, TripleClient } from "../sdk/client/index.ts";
import { Query } from "../sdk/shared/query.ts";
import type { Ref } from "../sdk/shared/types.ts";
import { newId } from "../sdk/shared/transaction.ts";
import { DEMO_TEAM, DEMO_USER, OTHER_USER, schema, Team, Todo, User } from "./shared/schema.ts";

const api = process.env.SMOKE_API ?? "http://localhost:3000/api";
const connect = () =>
  new TripleClient({ schema, transport: new HttpTransport(api) });

const myTodos = Query.from(Todo)
  .where("owner", { id: DEMO_USER })
  .select({ text: true, completed: true, tags: true });

const client = connect();
client.connect();
const todos = client.watch(myTodos);

let notifications = 0;
todos.subscribe(() => notifications++);

await todos.ready;
log("watch", `${todos.data.length} todos, ${client.size} triples cached`);

// create — optimistic: visible synchronously, before the server answers
const id = newId("todo");
const creating = client.transact((tx) => {
  tx.edit(Todo, id).text = "written by the client sdk";
  tx.edit(Todo, id).completed = false;
  tx.edit(Todo, id).owner = { id: DEMO_USER };
});
log(
  "optimistic",
  `visible before ack: ${todos.data.some((t) => t.id === id)}, pending: ${client.pendingCount}`,
);
await creating;
log(
  "create",
  `${todos.data.length} todos, pending: ${client.pendingCount} (ack absorbed, no refetch)`,
);

const row = () => todos.data.find((todo) => todo.id === id);

// single-valued → set replaces
await client.transact((tx) => (tx.edit(Todo, id).text = "renamed once"));
await client.transact((tx) => (tx.edit(Todo, id).text = "renamed twice"));
log("set x2", `text ${JSON.stringify(row()?.text)}, ${textTriples()} triple in the store`);

await client.transact((tx) => {
  tx.edit(Todo, id).text = "intermediate";
  tx.edit(Todo, id).text = "final";
});
log("set x2 in 1 tx", `text ${JSON.stringify(row()?.text)}, ${textTriples()} triple`);

// multiple → add appends
await client.transact((tx) => {
  tx.edit(Todo, id).tags.push("a");
  tx.edit(Todo, id).tags.push("b");
});
await client.transact((tx) => tx.edit(Todo, id).tags.push("c"));
log("add x3", JSON.stringify(row()?.tags));

// the store is a set — re-adding is a no-op. The cursor is stream-owned (§7.3),
// so let the echo settle before reading it on either side.
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
await settle();
const before = client.version;
await client.transact((tx) => tx.edit(Todo, id).tags.push("c"));
await settle();
log("re-add 'c'", `version ${before} → ${client.version} (no version burned)`);

// an unrelated predicate must not wake the query
const quiet = notifications;
await client.transact((tx) => (tx.edit(User, DEMO_USER).name = "Christian"));
log("unrelated write", `notifications ${quiet} → ${notifications} (user/name is not in this query)`);

// delete removes the subject and inbound refs
await client.transact((tx) => tx.delete(id));
log("delete", `${todos.data.length} todos, row gone: ${row() === undefined}`);

// §4.5: a create missing a required field is refused — passes policy (owner is
// me), fails the schema guarantee (no `completed`)
const partial = await client
  .transact((tx) => {
    const nid = newId("todo");
    tx.edit(Todo, nid).text = "half a todo";
    tx.edit(Todo, nid).owner = { id: DEMO_USER };
  })
  .then(() => "ALLOWED")
  .catch((error: Error) => error.message);
log("required field", partial);

// policy: another user's data never arrives
const everything = JSON.stringify(client.snapshot());
log(
  "policy",
  `Ada's todo in the cache: ${everything.includes("Ada's private todo")}, ` +
    `${client.size} of the server's triples cached`,
);

const refused = await client
  .transact((tx) => (tx.edit(Todo, "todo_not_mine").text = "hacked"))
  .then(() => "ALLOWED")
  .catch((error: Error) => error.message);
log("write to Ada's", refused);

// traversal: read via team membership, write still owner-only
const teamTodos = client.watch(
  Query.from(Todo)
    .where("team", { id: DEMO_TEAM })
    .select({ text: true, owner: true }),
);
await teamTodos.ready;
const shared = teamTodos.data[0];
log("team traversal", `${teamTodos.data.length} team todo visible, owned by ${shared?.owner?.id} (not me)`);

const teamText = () => teamTodos.data.find((t) => t.id === shared!.id)?.text;
const editing = client
  .transact((tx) => (tx.edit(Todo, shared!.id).text = "hijacked"))
  .then(() => "ALLOWED")
  .catch((error: Error) => error.message);
log("optimistic edit", `text is ${JSON.stringify(teamText())} while pending`);
const editShared = await editing;
log("edit team todo", editShared);
log("reject revert", `text is back to ${JSON.stringify(teamText())}`);

// §4.6: a subject's id prefix declares its entity — wrong pairings never leave
// the client
const wrongEntity = await client
  .transact((tx) => (tx.edit(Todo, DEMO_TEAM).text = "confused"))
  .then(() => "ALLOWED")
  .catch((error: Error) => error.message);
log("wrong entity", wrongEntity);

// §4.5 + §9.1: deleting a user other subjects still require is refused —
// referential integrity from required refs plus authoritative delete
const refInt = await client
  .transact((tx) => tx.delete(DEMO_USER))
  .then(() => "ALLOWED")
  .catch((error: Error) => error.message);
log("ref integrity", refInt);

// §11.4: rows keep object identity across re-runs when unchanged
const [rowA, rowB] = [todos.data[0]!, todos.data[1]!];
await client.transact((tx) => (tx.edit(Todo, rowB.id).completed = !rowB.completed));
const rowA2 = todos.data.find((t) => t.id === rowA.id);
log("row identity", `untouched row kept identity: ${rowA2 === rowA}`);

// §10.6: leaving the team is a permission change — and it arrives as a delta.
// The synthesized removes clean everything membership granted out of the cache.
await client.transact((tx) => tx.edit(Team, DEMO_TEAM).member.remove({ id: DEMO_USER }));
log("leave team", `${teamTodos.data.length} team todos left — revocation reached the cache live`);

const rejoin = await client
  .transact((tx) => tx.edit(Team, DEMO_TEAM).member.push({ id: DEMO_USER }))
  .then(() => "ALLOWED")
  .catch((error: Error) => error.message);
log("rejoin", `${rejoin} — you cannot grant yourself back in`);

// §13: presence and the ephemeral fast path
await settle();
log("presence", `${client.presence.length} online: ${JSON.stringify(client.presence)}`);

let frame: unknown;
const offEphemeral = client.onEphemeral((_actor, payload) => (frame = payload));
client.broadcast({ cursor: [12, 34] });
await settle();
log("ephemeral", `broadcast echoed back: ${JSON.stringify(frame)} (never logged, never versioned)`);
offEphemeral();

// §13: transact reports its outcome
const outcome = await client.transact((tx) => {
  const oid = newId("todo");
  tx.edit(Todo, oid).text = "outcome check";
  tx.edit(Todo, oid).completed = false;
  tx.edit(Todo, oid).owner = { id: DEMO_USER };
});
log("outcome", `online write → "${outcome}"`);

// §6.6: a live window — explicit order, server ships only the window, refills
const win = client.watch(
  Query.from(Todo).where("owner", { id: DEMO_USER }).orderBy("text").limit(2).select({ text: true }),
);
await win.ready;
log("window", `${win.data.length} rows, first: ${JSON.stringify(win.data[0]?.text)}`);
await client.transact((tx) => {
  const aid = newId("todo");
  tx.edit(Todo, aid).text = "AAA sorts first";
  tx.edit(Todo, aid).completed = false;
  tx.edit(Todo, aid).owner = { id: DEMO_USER };
});
await settle();
log("window shift", `first is now: ${JSON.stringify(win.data[0]?.text)}`);
await client.transact((tx) => tx.delete(win.data[0]!.id));
const deadline = Date.now() + 2000;
while (win.data.length < 2 && Date.now() < deadline) await settle();
log("window refill", `${win.data.length} rows after deleting the head — refetched`);

// §6.7 — whereId: load ONE known entity, no .where() needed. An absent (or
// invisible — same thing, §10.5) id yields zero rows, and a wrong id prefix
// throws before the wire.
const one = client.watch(
  Query.from(Todo).whereId(todos.data[0]!.id).select({ text: true }),
);
await one.ready;
const ghost = client.watch(Query.from(Todo).whereId("todo_nope").select({ text: true }));
await ghost.ready;
let prefixError = "";
try {
  Query.from(Todo).whereId("user_christian");
} catch (error) {
  prefixError = (error as Error).message;
}
log(
  "whereId",
  `pinned: ${JSON.stringify(one.data[0]?.text)} · absent: ${ghost.data.length} rows · wrong prefix throws: ${prefixError !== ""}`,
);
one.close();
ghost.close();

// §6.8 — correlated subquery: the JOIN. The select callback receives the row
// being built AS A REF, and the subquery pins a ref field to it — an ordinary
// query per parent row, with its own filters/order/limit.
const mine = client.watch(
  Query.from(User)
    .whereId(DEMO_USER)
    .select((user) => ({
      name: true,
      todos: Query.from(Todo).where("owner", user).orderBy("text").select({ text: true }),
    })),
);
await mine.ready;
log(
  "subquery join",
  `${JSON.stringify(mine.data[0]?.name)} ← ${mine.data[0]?.todos.length} todos via where("owner", user)`,
);
mine.close();

// §6.8 — callbacks at REF depth: the nested `owner` level gets ITS OWN handle,
// so the subquery correlates to each owner row, not the root.
const deep = client.watch(
  Query.from(Todo)
    .whereId(todos.data[0]!.id)
    .select({
      text: true,
      owner: (owner: Ref) => ({
        name: true,
        owned: Query.from(Todo).where("owner", owner).select({ text: true }),
      }),
    }),
);
await deep.ready;
log(
  "nested join",
  `${JSON.stringify(deep.data[0]?.text)} → owner ${JSON.stringify(deep.data[0]?.owner?.name)} owns ${deep.data[0]?.owner?.owned.length} todos`,
);
deep.close();

// §6.9 — negations refine (never seed), and stay SOUND on the partial cache:
// the server ships negation evidence for every candidate, so a triple missing
// from the cache is never mistaken for absence in the store.
const incomplete = client.watch(
  Query.from(Todo)
    .where("owner", { id: DEMO_USER })
    .whereNot("completed", true)
    .select({ text: true, completed: true }),
);
await incomplete.ready;
log(
  "whereNot",
  `${incomplete.data.length} incomplete todos · none completed: ${incomplete.data.every((r) => !r.completed)}`,
);
incomplete.close();

// §6.10 — whereEither: OR across conditions, here even SEEDING the query.
const either = client.watch(
  Query.from(Todo)
    .whereEither(
      (b) => b.where("owner", { id: DEMO_USER }),
      (b) => b.where("owner", { id: OTHER_USER }),
    )
    .select({ text: true }),
);
await either.ready;
log("whereEither", `${either.data.length} todos across two owner branches (OR)`);
either.close();

// §4.7 — object values: one triple, replaced whole, validated against the shape
// on BOTH write paths (draft: early throw; server: authoritative reject).
const positioned = client.watch(
  Query.from(Todo).whereId(todos.data[0]!.id).select({ position: true }),
);
await positioned.ready;
await client.transact((tx) => {
  tx.edit(Todo, todos.data[0]!.id).position = { x: 10, y: 20 };
});
await client.transact((tx) => {
  tx.edit(Todo, todos.data[0]!.id).position = { x: 11, y: 21 }; // replaced WHOLE
});
let shapeError = "";
try {
  await client.transact((tx) => {
    tx.edit(Todo, todos.data[0]!.id).position = { x: 1 } as never; // y missing
  });
} catch (error) {
  shapeError = (error as Error).message;
}
log(
  "object value",
  `position ${JSON.stringify(positioned.data[0]?.position)} · bad shape throws: ${shapeError !== ""}`,
);
positioned.close();

// §7.6 — closing a query EVICTS what no survivor needs: the cache is bounded by
// what is watched, not by session length. Ada's name is needed by THIS query only.
const peek = client.watch(Query.from(User).whereId(OTHER_USER).select({ name: true }));
await peek.ready;
const beforeEvict = client.size;
peek.close();
log("evict on close", `cache ${beforeEvict} → ${client.size} triples — Ada's name dropped with its last query`);
win.close();

// a second client converges on the same result
const other = connect();
other.connect();
const otherTodos = other.watch(myTodos);
await otherTodos.ready;
log(
  "second client",
  `${otherTodos.data.length} todos, version ${other.version} ` +
    `(converged: ${otherTodos.data.length === todos.data.length})`,
);

// realtime: a write on one client reaches the other with no refresh
const liveId = newId("todo");
const started = performance.now();
await client.transact((tx) => {
  tx.edit(Todo, liveId).text = "pushed live";
  tx.edit(Todo, liveId).completed = false;
  tx.edit(Todo, liveId).owner = { id: DEMO_USER };
});
await until(() => otherTodos.data.some((todo) => todo.id === liveId));
log(
  "live push",
  `second client saw the write in ${Math.round(performance.now() - started)}ms, ` +
    `versions ${client.version}/${other.version}`,
);

client.disconnect();
other.disconnect();

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for live push");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function textTriples(): number {
  return client.snapshot().filter((t) => t[0] === id && t[1] === "todo/text").length;
}

function log(label: string, detail: string): void {
  console.log(`  ${label.padEnd(16)} ${detail}`);
}
