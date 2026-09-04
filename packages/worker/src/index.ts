/**
 * The EDGE — the whole "server" (§12 as a product): authentication, the
 * workspace directory (WorkOS organizations), the standing of the caller in
 * the workspace they address, and one line of routing to the cell. Stateless;
 * every request re-verifies.
 *
 * Who gets through, and as whom (the cell's policy decides everything after):
 *   /w/:org/api/*, /w/:org/apps/*, /w/:org/schema.js
 *                                   members (with their role), app users (signed in, not a member),
 *                                   and anonymous (not signed in) — public apps need them
 *   /w/:org/mcp                     members only: the developer surface is not for visitors
 *   /mcp                            the SERVICE as one MCP server — what a claude.ai connector
 *                                   points at: OAuth (AuthKit) per the MCP spec, and the
 *                                   workspace is a tool argument. Same tools, routed to the cell.
 *   /w/:org/ops                     the OPERATOR plane: a service secret, never a user — raw
 *                                   reads, deletes, resets that bypass every rule (pnpm ops)
 */
import type { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";
import { TOOLS } from "workspace-platform";
import {
  createWorkspace,
  identify,
  inviteMember,
  loginCallback,
  loginRedirect,
  logout,
  mcpResource,
  memberships,
  mintToken,
  roleIn,
  type Env as AuthEnv,
  type Identity,
} from "./auth.ts";
export { WorkspaceCell } from "./cell.ts";

type Env = AuthEnv & { CELL: DurableObjectNamespace; ASSETS: Fetcher };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/auth/login") return loginRedirect(request, env);
    if (path === "/auth/callback") return loginCallback(request, env);
    if (path === "/auth/logout") return logout(request);

    // RFC 9728 — how an MCP client finds the authorization server: this
    // service is ONE OAuth resource (its /mcp), and AuthKit is its server.
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      return json(200, {
        resource: mcpResource(request),
        authorization_servers: env.WORKOS_AUTHKIT_DOMAIN ? [env.WORKOS_AUTHKIT_DOMAIN] : [],
        bearer_methods_supported: ["header"],
      });
    }
    if (path === "/mcp") return serviceMcp(request, env);

    // The operator plane never touches identity: a service secret, or nothing.
    const ops = /^\/w\/([\w-]+)\/ops$/.exec(path);
    if (ops) {
      const key = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!env.OPERATOR_KEY || key !== env.OPERATOR_KEY) return json(403, { error: "operator key required" });
      const cell = env.CELL.get(env.CELL.idFromName(ops[1]!));
      const forwarded = new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-operator": "1", "x-actor": "operator" },
        body: await request.text(),
      });
      return cell.fetch(forwarded as never) as unknown as Promise<Response>;
    }

    if (path === "/api/me" || path === "/api/workspaces" || path.startsWith("/w/")) {
      const identity = await identify(request, env);

      if (path === "/api/me") {
        return identity ? json(200, identity) : json(401, { error: "sign in first", login: "/auth/login" });
      }
      if (path === "/api/workspaces") {
        if (!identity) return json(401, { error: "sign in first" });
        if (request.method === "POST") {
          const { name } = (await request.json().catch(() => ({}))) as { name?: string };
          if (!name?.trim()) return json(400, { error: "a workspace needs a name" });
          return json(201, await createWorkspace(identity, name.trim(), env));
        }
        return json(200, await memberships(identity, env));
      }

      const match = /^\/w\/([\w-]+)\/(api\/|mcp$|apps\/|schema\.js$)/.exec(path);
      if (!match) return json(404, { error: "expected /w/<workspace>/{api,apps,mcp,schema.js}" });
      const org = match[1]!;
      if (identity?.org && identity.org !== org) return json(403, { error: "this token is for another workspace" });
      const role = identity ? await roleIn(request, identity, org, env) : null;
      if (match[2] === "mcp" && role !== "admin" && role !== "member") {
        return json(403, { error: "the developer surface is for workspace members" });
      }

      // Two edge-owned endpoints under a workspace: they talk to the identity
      // provider, which the cell never does.
      if (path === `/w/${org}/api/tokens` && request.method === "POST") {
        if (!identity || (role !== "admin" && role !== "member")) return json(403, { error: "members only" });
        if (identity.org) return json(403, { error: "a token cannot mint tokens" });
        const minted = await mintToken(identity, org, env);
        return json(201, { ...minted, mcp: new URL(`/w/${org}/mcp`, request.url).toString() });
      }
      if (path === `/w/${org}/api/invite` && request.method === "POST") {
        if (!identity || role !== "admin") return json(403, { error: "admins only" });
        const body = (await request.json().catch(() => ({}))) as { email?: string; role?: string };
        if (!body.email) return json(400, { error: "email required" });
        const invitedRole = body.role === "admin" ? "admin" : "member";
        return json(200, { message: await inviteMember(env, org, body.email, invitedRole) });
      }

      // The cell trusts these headers BECAUSE the edge sets them: strip
      // anything client-supplied first, then attach the verified identity —
      // or `anonymous`, so the cell's policy can admit public apps and
      // nothing else.
      const headers = new Headers(request.headers);
      for (const name of ["x-actor", "x-actor-name", "x-actor-email", "x-actor-role", "x-operator"]) headers.delete(name);
      if (identity && role) {
        headers.set("x-actor", identity.actor);
        headers.set("x-actor-name", identity.name);
        headers.set("x-actor-role", role);
        if (identity.email) headers.set("x-actor-email", identity.email);
      } else {
        headers.set("x-actor", "anonymous");
      }
      const forwarded = new Request(request, { headers });

      const cell = env.CELL.get(env.CELL.idFromName(org));
      const response = (await cell.fetch(forwarded as never)) as unknown as Response;

      // Nobody signed in, and the app root is not theirs to see: to the policy an
      // invisible app IS absent (§0.3), so the cell said 404 — the edge turns
      // that into "sign in, then come back".
      if (!identity && response.status === 404 && /^\/w\/[\w-]+\/apps\/[\w-]+\/$/.test(path)) {
        return Response.redirect(new URL(`/auth/login?return_to=${encodeURIComponent(path)}`, request.url).toString(), 302);
      }
      return response;
    }

    // Everything else is the app (SPA fallback configured in wrangler.toml).
    return env.ASSETS.fetch(request as never) as unknown as Promise<Response>;
  },
};

/**
 * The service as one MCP server. A connector (claude.ai) adds ONE URL and
 * signs in once; every workspace the member belongs to is reachable through a
 * `workspace` argument — omitted when they belong to exactly one. Tool calls
 * are forwarded, verbatim minus that argument, to the workspace's cell through
 * the same header rewrite as everything else.
 */
async function serviceMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("MCP speaks POST", { status: 405 });
  const identity = await identify(request, env);
  if (!identity) {
    // The MCP spec's door knock: 401 + where to find the resource metadata.
    const metadata = new URL("/.well-known/oauth-protected-resource", request.url).toString();
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer error="unauthorized", error_description="Authorization needed", resource_metadata="${metadata}"`,
      },
    });
  }
  const rpc = (await request.json().catch(() => null)) as
    | { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> }
    | null;
  if (!rpc) return json(400, { error: "expected a JSON-RPC message" });
  const respond = (result: unknown) => json(200, { jsonrpc: "2.0", id: rpc.id ?? null, result });
  const text = (value: unknown, isError = false) => ({
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  });

  switch (rpc.method) {
    case "initialize":
      return respond({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "workspaces", version: "0.3.0" },
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return respond({});
    case "tools/list":
      return respond({ tools: serviceTools() });
    case "tools/call": {
      const name = rpc.params?.name as string;
      const args = { ...((rpc.params?.arguments ?? {}) as Record<string, unknown>) };
      const mine = await memberships(identity, env);
      if (name === "list_workspaces") return respond(text(mine));
      const workspace = (args.workspace as string | undefined) ?? (mine.length === 1 ? mine[0]!.id : undefined);
      delete args.workspace;
      if (!workspace) {
        return respond(text(`error: say which workspace — you belong to ${mine.length}: ${mine.map((w) => `${w.id} (${w.name})`).join(", ")}`, true));
      }
      if (identity.org && identity.org !== workspace) return respond(text("error: this token is for another workspace", true));
      const role = await roleIn(request, identity, workspace, env);
      if (role !== "admin" && role !== "member") return respond(text(`error: you are not a member of ${workspace}`, true));
      const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
      setActor(headers, identity, role);
      const cell = env.CELL.get(env.CELL.idFromName(workspace));
      const forwarded = new Request(new URL(`/w/${workspace}/mcp`, request.url).toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({ ...rpc, params: { name, arguments: args } }),
      });
      return cell.fetch(forwarded as never) as unknown as Promise<Response>;
    }
    default:
      return respond({});
  }
}

function serviceTools(): unknown[] {
  const workspace = {
    type: "string",
    description: "The workspace id (from list_workspaces). Optional when you belong to exactly one.",
  };
  return [
    {
      name: "list_workspaces",
      description: "The workspaces you belong to, with your role in each. Every other tool takes one as `workspace`.",
      inputSchema: { type: "object", properties: {} },
    },
    ...TOOLS.map((tool) => ({
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: { workspace, ...(tool.inputSchema as { properties: object }).properties },
      },
    })),
  ];
}

/** The verified identity, as the cell reads it. Never from the client. */
function setActor(headers: Headers, identity: Identity, role: string): void {
  headers.set("x-actor", identity.actor);
  headers.set("x-actor-name", identity.name);
  headers.set("x-actor-role", role);
  if (identity.email) headers.set("x-actor-email", identity.email);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
