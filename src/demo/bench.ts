/**
 * npm run bench — the hot paths, measured in-process (no HTTP), so the numbers are
 * the SDK's own cost, not the network's.
 */

import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { TripleServer } from "../sdk/server/server.ts";
import { SqliteStorage } from "../sdk/server/sqlite.ts";
import { MemoryStorage, type StorageAdapter } from "../sdk/shared/storage.ts";
import { TripleClient } from "../sdk/client/index.ts";
import type { Transport } from "../sdk/client/transport.ts";
import { Query, toPayload } from "../sdk/shared/query.ts";
import { Transaction } from "../sdk/shared/transaction.ts";
import type { Triple } from "../sdk/shared/types.ts";
import { policy } from "./server/policy.ts";
import { Team, Todo, schema as appSchema } from "./shared/schema.ts";

const USERS = 20;
const TODOS = 20_000;      // 1k per user
const TEAM_TODOS = 500;
const SUBSCRIBERS = 500;

const seedTriples: Triple[] = [];
for (let u = 0; u < USERS; u++) seedTriples.push([`user_${u}`, "user/name", `User ${u}`]);
seedTriples.push(["team_big", "team/name", "Big"]);
for (let u = 0; u < USERS; u++) seedTriples.push(["team_big", "team/member", { id: `user_${u}` }]);
for (let i = 0; i < TODOS; i++) {
  seedTriples.push([`todo_${i}`, "todo/text", `todo number ${i}`]);
  seedTriples.push([`todo_${i}`, "todo/completed", i % 3 === 0]);
  seedTriples.push([`todo_${i}`, "todo/owner", { id: `user_${i % USERS}` }]);
  if (i < TEAM_TODOS) seedTriples.push([`todo_${i}`, "todo/team", { id: "team_big" }]);
}

const time = (fn: () => void, n: number) => {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return (performance.now() - t0) / n;
};
const row = (label: string, value: string) => console.log(`  ${label.padEnd(46)} ${value}`);

function bench(label: string, storage: StorageAdapter) {
  const t0 = performance.now();
  storage.apply({ added: seedTriples, removed: [] }, "system");
  const seedMs = performance.now() - t0;
  const server = new TripleServer({ schema: appSchema, policy, storage });

  const q = Query.from(Todo).where("owner", { id: "user_3" }).select({ text: true, completed: true });
  const query = time(
    () => server.query({ kind: "query", schema: server.schemaHash, payload: toPayload(q) }, "user_3"),
    5,
  );

  let n = 0;
  const write = time(() => {
    const tx = new Transaction(server.schema, server.storage);
    tx.set(Todo, `todo_w${label}${n}`, "text", "x");
    tx.set(Todo, `todo_w${label}${n}`, "completed", false);
    tx.set(Todo, `todo_w${label}${n++}`, "owner", { id: "user_1" });
    server.transact({ kind: "transact", schema: server.schemaHash, mutationId: "m", operations: tx.build().operations }, "user_1");
  }, 50);

  const qw = Query.from(Todo)
    .where("owner", { id: "user_3" })
    .orderBy("text")
    .limit(50)
    .select({ text: true, completed: true });
  const windowed = time(
    () => server.query({ kind: "query", schema: server.schemaHash, payload: toPayload(qw) }, "user_3"),
    5,
  );

  console.log(`\n${label} (${storage.snapshot().triples.length.toLocaleString()} triples)`);
  row("seed 60k triples", `${seedMs.toFixed(0)}ms`);
  row("query: 1k todos, policy-filtered", `${query.toFixed(1)}ms`);
  row("query: same, ordered window of 50", `${windowed.toFixed(1)}ms`);
  row("write: 3-triple transact, policy on", `${write.toFixed(2)}ms`);
  return server;
}

const memory = bench("memory", new MemoryStorage());
const dbPath = `${tmpdir()}/rdf-bench-${process.pid}.db`;
const sqlite = new SqliteStorage(dbPath);
bench("sqlite", sqlite);

// --- durability: close, reopen, everything still there -----------------------
const before = sqlite.snapshot();
sqlite.close();
const reopened = new SqliteStorage(dbPath);
const after = reopened.snapshot();
row("sqlite reopen: triples/version intact",
  `${after.triples.length === before.triples.length && after.version === before.version ? "yes" : "NO"}`);
reopened.close();
rmSync(dbPath, { force: true }); rmSync(dbPath + "-wal", { force: true }); rmSync(dbPath + "-shm", { force: true });

// --- fan-out and the revocation cliff (memory server) ------------------------
console.log(`\nfan-out (memory, ${SUBSCRIBERS} connected subscribers)`);
const stops: (() => void)[] = [];
for (let i = 0; i < SUBSCRIBERS; i++) stops.push(memory.subscribe(`u${i % USERS}`, () => {}));
let n = 0;
const fanout = time(() => {
  const tx = new Transaction(memory.schema, memory.storage);
  tx.set(Todo, `todo_f${n}`, "text", "x");
  tx.set(Todo, `todo_f${n}`, "completed", false);
  tx.set(Todo, `todo_f${n++}`, "owner", { id: "user_1" });
  memory.transact({ kind: "transact", schema: memory.schemaHash, mutationId: "m", operations: tx.build().operations }, "user_1");
}, 10);
row("write pushed to all subscribers", `${fanout.toFixed(1)}ms`);

const revoke = time(() => {
  const leave = new Transaction(memory.schema, memory.storage);
  leave.remove(Team, "team_big", "member", { id: "user_9" });
  memory.transact({ kind: "transact", schema: memory.schemaHash, mutationId: "r", operations: leave.build().operations }, "user_9");
  const rejoin = new Transaction(memory.schema, memory.storage);
  rejoin.add(Team, "team_big", "member", { id: "user_9" });
  memory.commit(rejoin);
}, 1) / 2;
row(`revocation: ${TEAM_TODOS}-todo team, per event`, `${revoke.toFixed(0)}ms (was 2552ms — shared+memoized fan-out)`);
for (const stop of stops) stop();

// --- client-side reactivity ---------------------------------------------------
const direct: Transport = {
  deltas: (_s, on) => memory.subscribe("user_3", on),
  query: async (m) => memory.query(m, "user_3"),
  transact: async (m) => memory.transact(m, "user_3"),
  broadcast: async (m) => memory.broadcast("user_3", m.payload),
};
const client = new TripleClient({ schema: appSchema, transport: direct });
const live = client.watch(Query.from(Todo).where("owner", { id: "user_3" }).select({ text: true, completed: true }));
await live.ready;
const rerun = time(() => {
  const tx = new Transaction(memory.schema, memory.storage);
  tx.set(Todo, "todo_3", "completed", true);
  memory.commit(tx);
  const undo = new Transaction(memory.schema, memory.storage);
  undo.set(Todo, "todo_3", "completed", false);
  memory.commit(undo);
}, 10) / 2;
console.log("\nclient");
row("1k-row live query, re-run per delta", `${rerun.toFixed(2)}ms`);
client.disconnect();
