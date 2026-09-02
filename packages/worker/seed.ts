/**
 * Seed the local dev workspace (org_dev): a couple of todos as Alice, and the
 * two starter apps — `todos` (the board this repo proved the SDK with) and
 * `members` — published through the SAME MCP calls an agent makes. Run
 * against `wrangler dev` with DEV_AUTH=1: `pnpm --filter worker seed`.
 */
import { readFileSync } from "node:fs";
import { TripleClient, HttpTransport } from "triple-sdk/client";
import { schema, Todo } from "app-schema";

const base = process.env.SEED_URL ?? "http://localhost:8787";
const org = process.env.SEED_ORG ?? "org_dev";
const alice = { "x-actor": "user_alice", "x-actor-name": "Alice", "x-actor-role": "admin" };

const client = new TripleClient({ schema, transport: new HttpTransport(`${base}/w/${org}/api`, alice) });
await client.connect();
const outcome = await client.transact((tx) => {
  tx.create(Todo, { text: "private: water the plants", completed: false, shared: false, owner: { id: "user_alice" }, tags: [] });
  tx.create(Todo, { text: "shared: plan the offsite", completed: false, shared: true, owner: { id: "user_alice" }, tags: ["wave"] });
});
console.log(`todos: ${outcome}`);
client.disconnect();

const mcp = async (tool: string, args: object): Promise<string> => {
  const response = await fetch(`${base}/w/${org}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...alice },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const { result } = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  if (result.isError) throw new Error(`${tool}: ${result.content[0]!.text}`);
  return result.content[0]!.text;
};

for (const app of ["todos", "members"]) {
  const content = readFileSync(new URL(`./apps/${app}/app.js`, import.meta.url), "utf8");
  await mcp("write_file", { app, path: "app.js", content });
  const published = JSON.parse(await mcp("publish", { app })) as { version: number; url: string };
  console.log(`${app}: release ${published.version} at ${base}${published.url}`);
}
