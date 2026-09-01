/**
 * Seed the local dev workspace (org_dev) with a couple of todos as Alice, so
 * there is something to see the first time you open an app or the MCP query
 * tool. Run against `wrangler dev` with DEV_AUTH=1: `pnpm --filter worker seed`.
 */
import { TripleClient, HttpTransport } from "triple-sdk/client";
import { schema, Todo } from "app-schema";

const base = process.env.SEED_API ?? "http://localhost:8787/w/org_dev/api";
const client = new TripleClient({
  schema,
  transport: new HttpTransport(base, {
    "x-actor": "user_alice",
    "x-actor-name": "Alice",
  }),
});
await client.connect();
const outcome = await client.transact((tx) => {
  tx.create(Todo, { text: "private: water the plants", completed: false, shared: false, owner: { id: "user_alice" }, tags: [] });
  tx.create(Todo, { text: "shared: plan the offsite", completed: false, shared: true, owner: { id: "user_alice" }, tags: ["wave"] });
});
console.log(`seeded ${base} as Alice: ${outcome}`);
client.disconnect();
