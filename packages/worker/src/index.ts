/**
 * The EDGE — the whole "server" (§12 as a product): authentication, the
 * workspace directory (WorkOS organizations), the membership gate, and one
 * line of routing to the cell. Stateless; every request re-verifies.
 */
import type { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";
import { identify, isMember, loginCallback, loginRedirect, logout, memberships, type Env as AuthEnv } from "./auth.ts";
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
      if (!identity) return json(401, { error: "sign in first", login: "/auth/login" });

      if (path === "/api/me") return json(200, identity);
      if (path === "/api/workspaces") return json(200, await memberships(identity, env));

      const match = /^\/w\/([\w-]+)\/api\//.exec(path);
      if (!match) return json(404, { error: "expected /w/<workspace>/api/*" });
      const org = match[1]!;
      if (!(await isMember(identity, org, env))) {
        return json(403, { error: "not a member of this workspace" });
      }

      // The cell trusts these headers BECAUSE the edge sets them: strip
      // anything client-supplied first, then attach the verified identity.
      const headers = new Headers(request.headers);
      headers.delete("x-actor");
      headers.delete("x-actor-name");
      headers.delete("x-actor-email");
      headers.set("x-actor", identity.actor);
      headers.set("x-actor-name", identity.name);
      if (identity.email) headers.set("x-actor-email", identity.email);
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
