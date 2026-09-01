/**
 * The MCP endpoint — the platform's developer surface, per workspace, hand-
 * rolled JSON-RPC over streamable HTTP (~zero deps, in the repo's spirit).
 * Files are the interface: every coding agent already knows how to develop
 * against a filesystem, so writeFile IS the deploy pipeline. The `query` tool
 * runs AS the authenticated user — the agent explores data permission-filtered,
 * like any other client.
 */
import type { TripleServer } from "triple-sdk/server";
import type { EntityDef } from "triple-sdk/schema";
import { Query, toPayload, runPayload } from "triple-sdk/query";
import { MemoryStorage } from "triple-sdk/storage";
import { schema } from "app-schema";
import type { AppFiles } from "./files.ts";

type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> };

const TOOLS = [
  {
    name: "get_schema",
    description:
      "The workspace's entities, fields and access rules, plus how apps are served. Read this first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_apps",
    description: "Apps deployed in this workspace.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_files",
    description: "Files of one app.",
    inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
  },
  {
    name: "read_file",
    description: "Read one file of an app.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string" }, path: { type: "string" } },
      required: ["app", "path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write one file of an app — this IS deployment: the file is live immediately at the app's URL. " +
      "Apps get an implicit index.html (Tailwind + import map + <div id=root> + ./app.js) unless you write your own. " +
      "Write plain-JS ES modules; components via `import { html, render } from 'htm/preact'`.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string" }, path: { type: "string" }, content: { type: "string" } },
      required: ["app", "path", "content"],
    },
  },
  {
    name: "delete_file",
    description: "Delete one file of an app.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string" }, path: { type: "string" } },
      required: ["app", "path"],
    },
  },
  {
    name: "query",
    description:
      "Query live workspace data AS YOU — the same permission-filtered rows an app would see. " +
      'Example: {"entity":"todo","where":{"shared":true},"select":["text","completed","owner"]}',
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Entity name from get_schema." },
        where: {
          type: "object",
          description:
            "field → required value. An array value means any-of. Ref fields take an id string.",
        },
        select: {
          type: "array",
          items: { type: "string" },
          description: "Field names to return (default: all fields).",
        },
      },
      required: ["entity"],
    },
  },
];

export async function handleMcp(
  request: Request,
  server: TripleServer,
  files: AppFiles,
  actor: string,
  appBase: string,
): Promise<Response> {
  if (request.method !== "POST") return new Response("MCP speaks POST", { status: 405 });
  const rpc = (await request.json()) as Rpc;

  const respond = (result: unknown): Response =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }), {
      headers: { "content-type": "application/json" },
    });
  const text = (value: unknown): unknown => ({
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  });

  switch (rpc.method) {
    case "initialize":
      return respond({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "workspace-apps", version: "0.1.0" },
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return respond({});
    case "tools/list":
      return respond({ tools: TOOLS });
    case "tools/call": {
      const name = rpc.params?.name as string;
      const args = (rpc.params?.arguments ?? {}) as Record<string, string> & {
        where?: Record<string, unknown>;
        select?: string[];
      };
      try {
        switch (name) {
          case "get_schema":
            return respond(text(describeWorkspace(appBase)));
          case "list_apps":
            return respond(text(files.apps()));
          case "list_files":
            return respond(text(files.list(args.app!)));
          case "read_file": {
            const content = files.read(args.app!, args.path!);
            return respond(text(content ?? `(no such file: ${args.app}/${args.path})`));
          }
          case "write_file": {
            if (!/^[\w-]+$/.test(args.app!) || !/^[\w./-]+$/.test(args.path!) || args.path!.includes("..")) {
              return respond(text("app must be [word-]; path must be a simple relative path"));
            }
            files.write(args.app!, args.path!, args.content!);
            return respond(text({ deployed: true, url: `${appBase}/${args.app}/` }));
          }
          case "delete_file":
            return respond(text({ deleted: files.delete(args.app!, args.path!) }));
          case "query": {
            // The SAME path an app takes: build with the real Query builder,
            // fetch permission-filtered triples, fold, materialize rows. The
            // wire format never surfaces here.
            const entity = (schema.entities as Record<string, EntityDef>)[args.entity!];
            if (!entity) {
              return respond(
                text(`error: no entity "${args.entity}" — one of: ${Object.keys(schema.entities).join(", ")}`),
              );
            }
            let query = Query.from(entity);
            for (const [field, raw] of Object.entries(args.where ?? {})) {
              const builder = entity[field];
              if (!builder) {
                return respond(text(`error: "${args.entity}" has no field "${field}"`));
              }
              // Refs travel as {id} — accept the bare id string agents naturally send.
              const asValue = (value: unknown): unknown =>
                builder.field.type === "ref" && typeof value === "string" ? { id: value } : value;
              const value = Array.isArray(raw) ? raw.map(asValue) : asValue(raw);
              query = query.where(field as never, value as never);
            }
            const names = args.select ?? Object.keys(entity);
            const selected = query.select(
              Object.fromEntries(names.map((name) => [name, true])) as never,
            );
            const payload = toPayload(selected);
            const result = server.query({ kind: "query", schema: schema.hash, payload }, actor);
            const cache = new MemoryStorage();
            cache.apply({ added: result.triples, removed: [] }, actor);
            return respond(text(runPayload(cache, schema.flat, payload)));
          }
          default:
            return respond(text(`unknown tool: ${name}`));
        }
      } catch (cause) {
        return respond({
          content: [{ type: "text", text: `error: ${(cause as Error).message}` }],
          isError: true,
        });
      }
    }
    default:
      return respond({});
  }
}

function describeWorkspace(appBase: string): string {
  const entities = Object.entries(schema.entities)
    .map(([name, fields]) => {
      const lines = Object.entries(fields).map(([field, builder]) => {
        const f = builder.field;
        const type = Array.isArray(f.type) ? f.type.join("|") : f.type;
        return `    ${field}: ${type}${f.multiple ? "[]" : ""}${f.optional ? "?" : ""}`;
      });
      return `  ${name}:\n${lines.join("\n")}`;
    })
    .join("\n");
  return [
    `Workspace schema (generation ${schema.hash}):`,
    entities,
    "",
    "Access rules: todos are PRIVATE to their owner unless shared=true (then every",
    "member sees them); only the owner writes, except `completed`, which anyone who",
    "can see the todo may toggle. Users: everyone reads, only you write yours.",
    "",
    "Building apps:",
    `- write_file deploys instantly; apps are served at ${appBase}/<app>/`,
    "- implicit index.html: Tailwind + import map + <div id=root> + ./app.js (write your own to override)",
    "- plain-JS ES modules; components: import { html, render } from 'htm/preact'",
    "- hooks: import { createHooks } from 'triple-sdk/react' (react maps to preact/compat)",
    "- data: import { TripleClient, HttpTransport } from 'triple-sdk/client';",
    "        import { Query } from 'triple-sdk/query'; import { schema, Todo, User } from 'schema';",
    "- the api base from inside an app: location.pathname.replace(/\\/apps\\/.*$/, '/api')",
    "- identity: await (await fetch('/api/me')).json() → { actor, name }; auth is ambient (cookies)",
    "- creating a todo: set owner to the viewer — tx.create(Todo, { …, owner: { id: me.actor } });",
    "  policy rejects creates owned by anyone else",
    "- every query (app or tool) needs at least one where — there is no 'all entities' scan",
  ].join("\n");
}
