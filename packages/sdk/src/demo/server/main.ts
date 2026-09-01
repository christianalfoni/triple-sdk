// One TripleServer = one CELL: its own data, log, versions, epoch. This is the
// whole backend of a workspace — the cells host routes /w/<ws>/api/* to many of
// these per process. SQLite lands store+log in ONE transaction (the invariant
// everything rides on: state and history can never disagree), persists the epoch
// with the data, and survives restarts — reconnecting clients replay the log.
// Measured: writes 0.13ms, windowed queries 1.4ms, ~5k writes/sec fanning out
// live to 500 subscribers, all with full policy on.
import { createServer } from "node:http";
import { SqliteStorage, TripleServer } from "../../sdk/server/index.ts";
import { createHttpHandler } from "../../sdk/server/http.ts";
import { DEMO_USER, schema } from "../shared/schema.ts";
import { policy } from "./policy.ts";
import { seed } from "./seed.ts";

const PORT = 3000;

// RDF_DB=path/to.db makes the demo durable: data, log, and epoch survive restarts,
// and reconnecting clients replay the log instead of resyncing. Default: in-memory.
const storage = process.env.RDF_DB ? new SqliteStorage(process.env.RDF_DB) : undefined;

const triples = new TripleServer({ schema, policy, ...(storage ? { storage } : {}) });
if (triples.storage.version === 0) seed(triples);

const resolveActor = () => DEMO_USER;

const http = createServer(createHttpHandler(triples, resolveActor));

http.listen(PORT, () => {
  const { version, triples: all } = triples.storage.snapshot();
  console.log(`\n  triple server  http://localhost:${PORT}`);
  console.log(`  storage        ${process.env.RDF_DB ?? "memory"} · ${all.length} triples at v${version}\n`);
});
