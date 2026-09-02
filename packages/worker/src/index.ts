/**
 * The EDGE — the whole "server" (§12 as a product): authentication, the
 * workspace directory (WorkOS organizations), the standing of the caller in
 * the workspace they address, and one line of routing to the cell. Stateless;
 * every request re-verifies.
 *
 * Who gets through, and as whom (the cell's policy decides everything after):
 *   /w/:org/api/*, /w/:org/apps/*   members (with their role), app users (signed in, not a member),
 *                                   and anonymous (not signed in) — public apps need them
 *   /w/:org/mcp                     members only: the developer surface is not for visitors
 */
import type { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";
import {
  identify,
  loginCallback,
  loginRedirect,
  logout,
  memberships,
  roleIn,
  type Env as AuthEnv,
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

    if (path === "/api/me" || path === "/api/workspaces" || path.startsWith("/w/")) {
      const identity = await identify(request, env);

      if (path === "/api/me") {
        return identity ? json(200, identity) : json(401, { error: "sign in first", login: "/auth/login" });
      }
      if (path === "/api/workspaces") {
        return identity ? json(200, await memberships(identity, env)) : json(401, { error: "sign in first" });
      }

      const match = /^\/w\/([\w-]+)\/(api\/|mcp$|apps\/)/.exec(path);
      if (!match) return json(404, { error: "expected /w/<workspace>/{api,apps,mcp}" });
      const org = match[1]!;
      const role = identity ? await roleIn(request, identity, org, env) : null;
      if (match[2] === "mcp" && role !== "admin" && role !== "member") {
        return json(403, { error: "the developer surface is for workspace members" });
      }

      // The cell trusts these headers BECAUSE the edge sets them: strip
      // anything client-supplied first, then attach the verified identity —
      // or `anonymous`, so the cell's policy can admit public apps and
      // nothing else.
      const headers = new Headers(request.headers);
      for (const name of ["x-actor", "x-actor-name", "x-actor-email", "x-actor-role"]) headers.delete(name);
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
      return cell.fetch(forwarded as never) as unknown as Promise<Response>;
    }

    // Everything else is the app (SPA fallback configured in wrangler.toml).
    return env.ASSETS.fetch(request as never) as unknown as Promise<Response>;
  },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
