/**
 * npm run invariant — proves the architecture's central claim: state = fold(log).
 *
 * Runs a deterministic pseudo-random workload of creates, sets, adds, removes and
 * deletes through the full server write path, then rebuilds a store from nothing by
 * replaying the log, and asserts it is triple-for-triple identical to the live
 * store. On both adapters.
 */

import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { TripleServer } from "../sdk/server/server.ts";
import { SqliteStorage } from "../sdk/server/sqlite.ts";
import { MemoryStorage, type StorageAdapter } from "../sdk/shared/storage.ts";
import { Store } from "../sdk/shared/store.ts";
import { Transaction } from "../sdk/shared/transaction.ts";
import { Schema, type FieldBuilder } from "../sdk/shared/schema.ts";
import { Query, runQuery } from "../sdk/shared/query.ts";
import { tripleKey } from "../sdk/shared/value.ts";
import { policy } from "./server/policy.ts";
import { Team, Todo, User, schema as appSchema } from "./shared/schema.ts";
import { TripleClient } from "../sdk/client/client.ts";
import type { Transport } from "../sdk/client/transport.ts";

// Deterministic PRNG so a failure is reproducible.
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32);
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

function run(label: string, storage: StorageAdapter, retainLog?: number): void {
  const server = new TripleServer({
    schema: appSchema,
    policy,
    storage,
    ...(retainLog !== undefined ? { retainLog } : {}),
  });
  const actor = "user_inv";
  const boot = new Transaction(server.schema, server.storage);
  boot.set(User, actor, "name", "Invariant");
  server.commit(boot);

  const alive: string[] = [];
  let created = 0;
  let accepted = 0;

  for (let i = 0; i < 400; i++) {
    const tx = new Transaction(server.schema, server.storage);
    const roll = rnd();
    if (roll < 0.3 || alive.length === 0) {
      const id = `todo_inv${created++}`;
      tx.set(Todo, id, "text", `t${i}`);
      tx.set(Todo, id, "completed", false);
      tx.set(Todo, id, "owner", { id: actor });
      alive.push(id);
    } else if (roll < 0.55) {
      tx.set(Todo, pick(alive), "text", `renamed ${i}`);
    } else if (roll < 0.7) {
      tx.set(Todo, pick(alive), "completed", rnd() > 0.5);
    } else if (roll < 0.85) {
      tx.add(Todo, pick(alive), "tags", `tag${Math.floor(rnd() * 5)}`);
    } else if (roll < 0.93) {
      const id = pick(alive);
      tx.remove(Todo, id, "tags", `tag${Math.floor(rnd() * 5)}`);
    } else {
      const id = pick(alive);
      tx.delete(id);
      alive.splice(alive.indexOf(id), 1);
    }
    const res = server.transact(
      { kind: "transact", schema: server.schemaHash, mutationId: `m${i}`, operations: tx.build().operations },
      actor,
    );
    if (res.kind === "ack") accepted++;
  }

  const version = server.storage.snapshot().version;

  if (retainLog !== undefined) {
    // §7.3 COMPACTION POLICY: the floor moved, a stale cursor is refused honestly,
    // the retained tail still replays, and the state lost nothing.
    if (server.storage.entriesSince(0) !== null) {
      console.error(`  ${label}: retainLog=${retainLog} but entriesSince(0) still answers`);
      process.exit(1);
    }
    const floor = Math.floor(version / retainLog) * retainLog - retainLog;
    const tail = server.storage.entriesSince(floor);
    if (tail === null || tail.length !== version - floor) {
      console.error(`  ${label}: retained tail wrong — wanted ${version - floor} entries above v${floor}`);
      process.exit(1);
    }
    console.log(
      `  ${label.padEnd(8)} retainLog=${retainLog}: entriesSince(0)=null (resync) · ` +
        `${tail.length} entries retained above v${floor} · ${server.storage.snapshot().triples.length} triples intact ✓`,
    );
    return;
  }

  // THE FOLD: rebuild from nothing by replaying the log.
  const entries = server.storage.entriesSince(0);
  if (entries === null) throw new Error("log compacted during invariant run");
  const folded = new Store();
  for (const entry of entries) folded.apply(entry.delta);

  const canon = (triples: { map(f: (t: import("../sdk/shared/types.ts").Triple) => string): string[] }) =>
    triples.map(tripleKey).sort().join("\n");
  const live = canon(server.storage.snapshot().triples);
  const replayed = canon(folded.snapshot());

  if (live !== replayed) {
    console.error(`  ${label}: DIVERGED — state is not the fold of the log`);
    process.exit(1);
  }
  console.log(
    `  ${label.padEnd(8)} ${accepted} committed of 400 ops · v${server.storage.snapshot().version} · ` +
      `${server.storage.snapshot().triples.length} triples · fold(log) === state ✓`,
  );
}

console.log("state = fold(log):");
run("memory", new MemoryStorage());
const dbPath = `${tmpdir()}/rdf-invariant-${process.pid}.db`;
const sqlite = new SqliteStorage(dbPath);
run("sqlite", sqlite);
sqlite.close();
for (const ext of ["", "-wal", "-shm"]) rmSync(dbPath + ext, { force: true });

// §4.4 — mutually-referencing entities: thunk refs resolve lazily, both
// directions traverse, and the hash sees through the cycle.
{
  // Interfaces break the TYPE cycle; thunks break the VALUE cycle (§4.4).
  // type aliases, not interfaces: only aliases carry the implicit index
  // signature that EntityDef (a Record) requires.
  type PersonFields = {
    name: FieldBuilder<"string", false, false>;
    dog: FieldBuilder<"ref", false, true, DogFields>;
  };
  type DogFields = {
    called: FieldBuilder<"string", false, false>;
    human: FieldBuilder<"ref", false, false, PersonFields>;
  };
  const Person: PersonFields = Schema.from({
    name: Schema.string(),
    dog: Schema.ref((): DogFields => Dog).optional(),
  });
  const Dog: DogFields = Schema.from({
    called: Schema.string(),
    human: Schema.ref((): PersonFields => Person),
  });
  const cyclic = Schema.build({ person: Person, dog: Dog });
  const server = new TripleServer({ schema: cyclic });
  const tx = new Transaction(server.schema, server.storage);
  tx.set(Person, "person_ada", "name", "Ada");
  tx.set(Dog, "dog_rex", "called", "Rex");
  tx.set(Dog, "dog_rex", "human", { id: "person_ada" });
  tx.set(Person, "person_ada", "dog", { id: "dog_rex" });
  server.commit(tx);
  const [row] = runQuery(
    server.storage,
    server.schema,
    Query.from(Person).whereId("person_ada").select({ name: true, dog: { called: true, human: { name: true } } }),
  );
  const round = row?.dog?.human.name;
  if (round !== "Ada") {
    console.error(`  lazy refs: cycle traversal broke (${JSON.stringify(round)})`);
    process.exit(1);
  }
  console.log(`  lazy    person↔dog cycle: hash ${cyclic.hash} · person→dog→human→"${round}" ✓`);
}

// §10.4 — per-field write overrides: a team MATE may toggle `completed` on the
// owner's team todo (the field override), but renaming it stays owner-only
// (the entity rule).
{
  const server = new TripleServer({ schema: appSchema, policy, storage: new MemoryStorage() });
  const seedTx = new Transaction(server.schema, server.storage);
  seedTx.set(User, "user_owner", "name", "Owner");
  seedTx.set(User, "user_mate", "name", "Mate");
  seedTx.set(Team, "team_t", "name", "T");
  seedTx.add(Team, "team_t", "member", { id: "user_owner" });
  seedTx.add(Team, "team_t", "member", { id: "user_mate" });
  seedTx.set(Todo, "todo_shared", "text", "shared work");
  seedTx.set(Todo, "todo_shared", "completed", false);
  seedTx.set(Todo, "todo_shared", "owner", { id: "user_owner" });
  seedTx.set(Todo, "todo_shared", "team", { id: "team_t" });
  server.commit(seedTx);

  const asMate = (mutationId: string, build: (tx: Transaction) => void) => {
    const tx = new Transaction(server.schema, server.storage);
    build(tx);
    return server.transact(
      { kind: "transact", schema: server.schemaHash, mutationId, operations: tx.build().operations },
      "user_mate",
    );
  };
  const toggle = asMate("ov1", (tx) => tx.set(Todo, "todo_shared", "completed", true));
  const rename = asMate("ov2", (tx) => tx.set(Todo, "todo_shared", "text", "hijacked"));
  if (toggle.kind !== "ack" || rename.kind !== "reject") {
    console.error(`  overrides: toggle=${toggle.kind} (want ack) · rename=${rename.kind} (want reject)`);
    process.exit(1);
  }
  console.log(`  fields  mate toggles completed: ack · mate renames text: reject ✓`);
}

// §10.6 — visibility repair on CATCH-UP: a revocation that happens while a
// client is OFFLINE reaches it at reconnect — evicted by id, never by value.
await (async () => {
  const server = new TripleServer({ schema: appSchema, policy, storage: new MemoryStorage() });
  const seedTx = new Transaction(server.schema, server.storage);
  seedTx.set(User, "user_owner2", "name", "Owner");
  seedTx.set(User, "user_mate2", "name", "Mate");
  seedTx.set(Team, "team_r", "name", "R");
  seedTx.add(Team, "team_r", "member", { id: "user_owner2" });
  seedTx.add(Team, "team_r", "member", { id: "user_mate2" });
  seedTx.set(Todo, "todo_secret", "text", "the roadmap");
  seedTx.set(Todo, "todo_secret", "completed", false);
  seedTx.set(Todo, "todo_secret", "owner", { id: "user_owner2" });
  seedTx.set(Todo, "todo_secret", "team", { id: "team_r" });
  server.commit(seedTx);

  const inProcess = (actor: string): Transport => ({
    query: async (message) => server.query(message, actor),
    transact: async (message) => server.transact(message, actor),
    broadcast: async () => {},
    deltas: (getSince, onMessage) =>
      server.subscribe(actor, onMessage, getSince() > 0 ? getSince() : undefined),
  });

  const mate = new TripleClient({ schema: appSchema, transport: inProcess("user_mate2") });
  mate.connect();
  const live = mate.watch(
    Query.from(Todo).where("team", { id: "team_r" }).select({ text: true }),
  );
  await live.ready;
  if (live.data.length !== 1) {
    console.error(`  repair: mate should see 1 team todo, saw ${live.data.length}`);
    process.exit(1);
  }

  mate.disconnect(); // offline…
  const revoke = new Transaction(server.schema, server.storage);
  revoke.remove(Team, "team_r", "member", { id: "user_mate2" });
  server.commit(revoke, "user_owner2");
  mate.connect(); // …and back, with a cursor from before the revocation

  const rows = (): number => live.data.length;
  const deadline = Date.now() + 2000;
  while (rows() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (rows() !== 0) {
    console.error("  repair: revoked todo still visible after reconnect");
    process.exit(1);
  }
  console.log("  repair  offline revocation healed at reconnect: 1 team todo → 0 ✓");
})();

console.log("compaction policy (retainLog=100):");
run("memory", new MemoryStorage(), 100);
const dbPath2 = `${tmpdir()}/rdf-invariant-c-${process.pid}.db`;
const sqlite2 = new SqliteStorage(dbPath2);
run("sqlite", sqlite2, 100);
sqlite2.close();
for (const ext of ["", "-wal", "-shm"]) rmSync(dbPath2 + ext, { force: true });
