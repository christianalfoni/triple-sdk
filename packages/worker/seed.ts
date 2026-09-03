/**
 * Seed the local dev workspace (org_dev): DECLARE the todo schema over MCP,
 * add a couple of todos as Alice, and publish the two starter apps — `todos`
 * and `members` — through the same MCP calls an agent makes. Run against
 * `wrangler dev` with DEV_AUTH=1: `pnpm --filter worker seed`.
 */
import { readFileSync } from "node:fs";
import { TripleClient, HttpTransport } from "triple-sdk/client";
import { Schema, entitiesFromDeclaration } from "triple-sdk/schema";
import { platform, User } from "app-schema";
import { todos } from "./declarations/todos.ts";

const base = process.env.SEED_URL ?? "http://localhost:8787";
const org = process.env.SEED_ORG ?? "org_dev";
// Real auth: a workspace token minted in the console (SEED_TOKEN=wt_…). Dev: headers.
const alice: Record<string, string> = process.env.SEED_TOKEN
  ? { authorization: `Bearer ${process.env.SEED_TOKEN}` }
  : { "x-actor": "user_alice", "x-actor-name": "Alice", "x-actor-role": "admin" };

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

// 1. The schema — the same declaration the smoke proves the rules through.
const declared = JSON.parse(await mcp("set_schema", { declaration: todos })) as { generation: string };
console.log(`schema: todo declared, generation ${declared.generation}`);

// 2. A client speaking that generation: fixed entities + the declared ones, built identically.
const entities = entitiesFromDeclaration(todos, { user: User, ...platform });
const schema = Schema.build({ user: User, ...platform, ...entities });
const Todo = entities.todo!;

const who = await fetch(`${base}/w/${org}/api/me`, { headers: alice });
if (!who.ok) throw new Error(`not signed in to ${org}: ${who.status} — set SEED_TOKEN (console → agent token)`);
const me = ((await who.json()) as { actor: string }).actor;

const client = new TripleClient({ schema, transport: new HttpTransport(`${base}/w/${org}/api`, alice) });
await client.connect();
const outcome = await client.transact((tx) => {
  tx.create(Todo, { text: "private: water the plants", completed: false, shared: false, owner: { id: me }, tags: [] } as never);
  tx.create(Todo, { text: "shared: plan the offsite", completed: false, shared: true, owner: { id: me }, tags: ["wave"] } as never);
});
console.log(`todos: ${outcome}`);
client.disconnect();

// 3. The starter apps, published like any agent would.
for (const app of ["todos", "members"]) {
  const content = readFileSync(new URL(`./apps/${app}/app.js`, import.meta.url), "utf8");
  await mcp("write_file", { app, path: "app.js", content });
  const published = JSON.parse(await mcp("publish", { app })) as { version: number; url: string };
  console.log(`${app}: release ${published.version} at ${published.url}`);
}
