/**
 * The MCP endpoint — the platform's developer surface, per workspace cell:
 * hand-rolled JSON-RPC over stateless streamable HTTP (~zero deps, in the
 * repo's spirit). Files are the interface — every coding agent already knows
 * how to develop against a filesystem — so write_file is the deploy pipeline
 * and publish is the release button. Every tool runs AS the authenticated
 * member: reads are permission-filtered, writes are policy-checked, exactly
 * like an app's.
 *
 * The protocol itself is documented in ../README.md.
 */
import { Query } from "triple-sdk/query";
import type { EntityDef } from "triple-sdk/schema";
import type { Platform } from "./platform.ts";

type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> };

export type McpOptions = {
  platform: Platform;
  /** The verified member this request acts as. */
  actor: string;
  /** Where this workspace's apps are served: `${appBase}/<name>/` (live) and `${appBase}/<name>/draft/`. */
  appBase: string;
  /** The workspace's access rules in prose — policies are lambdas and cannot describe themselves. */
  accessRules: string;
  /**
   * Invite someone INTO the workspace, as a member — the identity provider's
   * job (an organization invitation), so the host supplies it. Returns a
   * human-readable outcome. Admin-only; the endpoint checks the caller's role.
   */
  inviteMember?: (email: string, role: "admin" | "member") => Promise<string>;
};

const TOOLS = [
  {
    name: "get_schema",
    description:
      "The workspace's entities and fields, its access rules, and how apps are built, served and published. Read this first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_apps",
    description: "Every app in this workspace, with its live version (null = never published).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_files",
    description: "The draft files of one app.",
    inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
  },
  {
    name: "read_file",
    description: "Read one draft file.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string" }, path: { type: "string" } },
      required: ["app", "path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or replace one DRAFT file — live immediately on the app's draft URL; members keep seeing the last published release until you `publish`. " +
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
    description: "Delete one draft file.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string" }, path: { type: "string" } },
      required: ["app", "path"],
    },
  },
  {
    name: "publish",
    description:
      "Snapshot the app's drafts as the next release and point the live URL at it — one atomic transaction. " +
      "Releases are immutable; rollback is publishing again. Running apps that watch their App row see the new version live.",
    inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
  },
  {
    name: "unpublish",
    description: "Take the app off its live URL (404 until the next publish). Releases stay — history is permanent.",
    inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
  },
  {
    name: "set_audience",
    description:
      "Who may OPEN the app. members (default): every workspace member. invited: ONLY the emails added with invite_to_app — " +
      "members or outsiders alike (outsiders sign in and become app users). public: anyone, signed in or not. Admins always may. " +
      "App users and anonymous viewers reach the same /api under the same policy, so they only ever see data the rules grant them.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string" }, audience: { type: "string", enum: ["members", "invited", "public"] } },
      required: ["app", "audience"],
    },
  },
  {
    name: "invite_to_app",
    description: "Admit one person to an app (audience must be invited) by the email their sign-in carries — a member, or an outsider who becomes an app user.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string" }, email: { type: "string" } },
      required: ["app", "email"],
    },
  },
  {
    name: "invite_member",
    description: "Invite someone into the WORKSPACE as a member (admins only) — an organization invitation from the identity provider.",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string" }, role: { type: "string", enum: ["admin", "member"] } },
      required: ["email"],
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
            "field → required value. Omit for every instance (a scan — prefer a where). An array value means any-of. Ref fields take an id string.",
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

export async function handleMcp(request: Request, options: McpOptions): Promise<Response> {
  const { platform, actor, appBase, accessRules, inviteMember } = options;
  if (request.method !== "POST") return new Response("MCP speaks POST", { status: 405 });
  const rpc = (await request.json()) as Rpc;

  const respond = (result: unknown): Response =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }), {
      headers: { "content-type": "application/json" },
    });
  const text = (value: unknown): unknown => ({
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  });
  const validName = (app: string | undefined, path?: string): string | null => {
    if (!app || !/^[\w-]+$/.test(app) || app === "draft") return "app must match [A-Za-z0-9_-]+ (and not be 'draft')";
    if (path !== undefined && (!/^[\w./-]+$/.test(path) || path.includes("..") || path.startsWith("draft/"))) {
      return "path must be a simple relative path (no '..', not under 'draft/')";
    }
    return null;
  };

  switch (rpc.method) {
    case "initialize":
      return respond({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "workspace-platform", version: "0.2.0" },
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
            return respond(text(describeWorkspace(platform, appBase, accessRules)));
          case "list_apps":
            return respond(
              text(
                platform.apps(actor).map((app) => ({
                  name: app.name,
                  live: app.live?.version ?? null,
                  audience: app.audience,
                  ...(app.audience === "invited" ? { invited: app.invited } : {}),
                })),
              ),
            );
          case "list_files": {
            const app = platform.appByName(actor, args.app!);
            return respond(text(app ? platform.drafts(actor, app).map((file) => file.path) : []));
          }
          case "read_file": {
            const app = platform.appByName(actor, args.app!);
            const file = app ? platform.draft(actor, app, args.path!) : undefined;
            return respond(text(file?.content ?? `(no such draft file: ${args.app}/${args.path})`));
          }
          case "write_file": {
            const problem = validName(args.app, args.path);
            if (problem) return respond(text(`error: ${problem}`));
            platform.writeDraft(actor, args.app!, args.path!, args.content!);
            return respond(
              text({
                draft: `${appBase}/${args.app}/draft/`,
                note: "live URL unchanged until you publish",
              }),
            );
          }
          case "delete_file":
            return respond(text({ deleted: platform.deleteDraft(actor, args.app!, args.path!) }));
          case "publish": {
            const problem = validName(args.app);
            if (problem) return respond(text(`error: ${problem}`));
            const { version } = platform.publish(actor, args.app!);
            return respond(text({ version, url: `${appBase}/${args.app}/` }));
          }
          case "unpublish":
            platform.unpublish(actor, args.app!);
            return respond(text({ live: null, url: `${appBase}/${args.app}/` }));
          case "set_audience": {
            const audience = args.audience as "members" | "invited" | "public";
            if (!["members", "invited", "public"].includes(audience)) {
              return respond(text("error: audience must be members, invited or public"));
            }
            platform.setAudience(actor, args.app!, audience);
            return respond(text({ app: args.app, audience }));
          }
          case "invite_to_app": {
            if (!/^[^\s@]+@[^\s@]+$/.test(args.email ?? "")) return respond(text("error: that is not an email"));
            return respond(text(platform.inviteToApp(actor, args.app!, args.email!)));
          }
          case "invite_member": {
            if (platform.actorRecord(actor).role !== "admin") {
              return respond(text("error: only workspace admins invite members"));
            }
            if (!inviteMember) return respond(text("error: this workspace has no member directory configured"));
            const role = (args.role as "admin" | "member" | undefined) ?? "member";
            if (role !== "admin" && role !== "member") return respond(text("error: role must be admin or member"));
            return respond(text(await inviteMember(args.email!, role)));
          }
          case "query":
            return respond(text(runQueryTool(platform, actor, args)));
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

/**
 * The query tool speaks the SCHEMA's vocabulary — entity, field, value — and
 * lets the real Query builder assemble the payload. The wire format never
 * surfaces; an agent needs to know the workspace, not the protocol.
 */
function runQueryTool(
  platform: Platform,
  actor: string,
  args: { entity?: string; where?: Record<string, unknown>; select?: string[] },
): unknown {
  const entities = platform.schema.entities as Record<string, EntityDef>;
  const entity = entities[args.entity ?? ""];
  if (!entity) return `error: no entity "${args.entity}" — one of: ${Object.keys(entities).join(", ")}`;
  let query = Query.from(entity);
  for (const [field, raw] of Object.entries(args.where ?? {})) {
    const builder = entity[field];
    if (!builder) return `error: "${args.entity}" has no field "${field}"`;
    // Refs travel as {id} — accept the bare id string agents naturally send.
    const asValue = (value: unknown): unknown =>
      builder.field.type === "ref" && typeof value === "string" ? { id: value } : value;
    const value = Array.isArray(raw) ? raw.map(asValue) : asValue(raw);
    query = query.where(field as never, value as never);
  }
  const names = args.select ?? Object.keys(entity);
  const selected = query.select(Object.fromEntries(names.map((name) => [name, true])) as never);
  return platform.queryAs(actor, selected);
}

function describeWorkspace(platform: Platform, appBase: string, accessRules: string): string {
  const { schema } = platform;
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
    "Access rules:",
    accessRules,
    "",
    "Who is who (ctx.actor.role in every rule, mirrored from the identity provider):",
    "- admin, member: workspace members. They develop — every app's drafts, publish, audiences, invites.",
    "- appUser: signed in but not a member — an app's user. Opens apps whose audience admits them; sees only",
    "  the data the rules grant an app user (typically: what they own). They never see drafts.",
    "- anonymous: not signed in. Opens public apps only; /api/me is 401 for them.",
    "Apps start members-only. set_audience changes who may open them; invite_to_app lists emails; releases are immutable.",
    "",
    "Building apps:",
    `- write_file edits DRAFTS, served immediately at ${appBase}/<app>/draft/`,
    `- publish snapshots the drafts as release N and serves it at ${appBase}/<app>/ — viewers see only releases`,
    "- implicit index.html: Tailwind + import map + <div id=root> + ./app.js (write your own to override)",
    "- plain-JS ES modules; components: import { html, render } from 'htm/preact'",
    "- hooks: import { createHooks } from 'triple-sdk/react' (react maps to preact/compat)",
    "- data: import { TripleClient, HttpTransport } from 'triple-sdk/client';",
    "        import { Query } from 'triple-sdk/query'; import { schema, App, Todo, User } from 'schema';",
    "- who is looking: import { auth } from 'auth'; const me = await auth.me(); // { actor, name, email?, role } or null",
    "  null means nobody is signed in → auth.login() sends them to sign in and back here. auth.apiBase is this workspace's /api:",
    "  new TripleClient({ schema, transport: new HttpTransport(auth.apiBase) }). Auth is ambient — a cookie; nothing to attach.",
    "- a query with no where means EVERY instance you may see (Query.from(App).select(…)) — a scan, so lead with a where when you can",
    "- your own version, live: useQuery(() => Query.from(App).where('name', '<app>').select({ live: { version: true } }), [])",
    "  — re-renders when someone publishes; show 'new version, refresh' from it",
  ].join("\n");
}
