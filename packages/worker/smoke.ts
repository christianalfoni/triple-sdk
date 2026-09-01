/**
 * The SERVICE smoke: two members of one workspace, over the real worker
 * (wrangler dev, DEV_AUTH=1) — proving the product's contract end to end:
 * membership at the edge, privacy and sharing in the policy, the collaborative
 * `completed` override, and unshare arriving at the other member LIVE.
 *
 *   pnpm --filter worker dev     (terminal 1)
 *   pnpm --filter worker smoke   (terminal 2)
 */
import { HttpTransport, TripleClient } from "triple-sdk/client";
import { Query } from "triple-sdk/query";
import { schema, Todo } from "app-schema";

const base = process.env.SMOKE_URL ?? "http://localhost:8787";
const org = `org_smoke_${Math.floor(Math.random() * 1e6)}`;

function member(actor: string, name: string): TripleClient {
  const client = new TripleClient({
    schema,
    transport: new HttpTransport(`${base}/w/${org}/api`, {
      "x-actor": actor,
      "x-actor-name": name,
    }),
  });
  client.connect();
  return client;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
let step = 0;
const log = (label: string, detail: string) =>
  console.log(`  ${String(++step).padStart(2)}. ${label.padEnd(18)} ${detail}`);
const fail = (message: string): never => {
  console.error(`  FAIL: ${message}`);
  process.exit(1);
};

// -- the edge gate: no identity in prod-mode would 401; DEV_AUTH forwards ours.
const me = await fetch(`${base}/api/me`, { headers: { "x-actor": "user_alice" } });
if (!me.ok) fail(`/api/me: ${me.status}`);
log("edge identity", JSON.stringify(await me.json()));

const alice = member("user_alice", "Alice");
const bob = member("user_bob", "Bob");

const boardQuery = Query.from(Todo)
  .where("shared", true)
  .select({ text: true, completed: true, owner: { name: true } });
const aliceAll = alice.watch(
  Query.from(Todo).where("owner", { id: "user_alice" }).select({ text: true, shared: true }),
);
const bobBoard = bob.watch(boardQuery);

await alice.transact((tx) => {
  tx.create(Todo, { text: "alice private", completed: false, shared: false, owner: { id: "user_alice" } });
  tx.create(Todo, { text: "alice shared", completed: false, shared: true, owner: { id: "user_alice" } });
});
await aliceAll.ready;
await bobBoard.ready;
await settle();

if (aliceAll.data.length !== 2) fail(`alice sees ${aliceAll.data.length} of her own todos`);
log("owner sees all", `alice: ${aliceAll.data.length} todos (private + shared)`);

if (bobBoard.data.length !== 1 || bobBoard.data[0]!.text !== "alice shared") {
  fail(`bob sees ${JSON.stringify(bobBoard.data.map((t) => t.text))} — privacy leak or missing share`);
}
log("privacy", `bob sees ONLY the shared todo (by ${bobBoard.data[0]!.owner.name})`);

// -- the collaborative override: bob may TICK alice's shared todo…
const sharedId = bobBoard.data[0]!.id;
const tick = await bob.transact((tx) => {
  tx.edit(Todo, sharedId).completed = true;
});
log("override", `bob ticks alice's shared todo: ${tick}`);

// -- …but may not rename it.
let renameRejected = false;
try {
  await bob.transact((tx) => {
    tx.edit(Todo, sharedId).text = "bob was here";
  });
} catch {
  renameRejected = true;
}
if (!renameRejected) fail("bob renamed alice's todo");
log("row rules", "bob's rename is rejected (owner-only)");

// -- UNSHARE: visibility revoked, arriving at bob as a live removal.
await alice.transact((tx) => {
  tx.edit(Todo, sharedId).shared = false;
});
const deadline = Date.now() + 3000;
while (bobBoard.data.length > 0 && Date.now() < deadline) await settle();
if (bobBoard.data.length !== 0) fail("unshare did not revoke live");
log("live revocation", "alice unshares → the todo VANISHES from bob's board");

// -- and alice still has it, privately.
if (aliceAll.data.length !== 2) fail("alice lost her todo on unshare");
log("still hers", `alice keeps both todos; shared flags: ${JSON.stringify(aliceAll.data.map((t) => t.shared))}`);

console.log("service smoke: all green");
process.exit(0);
