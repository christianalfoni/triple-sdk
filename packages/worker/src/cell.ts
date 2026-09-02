/**
 * §12 — the CELL: one workspace = one Durable Object = one SQLite file. The
 * edge (index.ts) has already authenticated the request and checked org
 * membership; the verified identity arrives as headers the edge itself set
 * (client-supplied ones are stripped there). Inside, the cell trusts the edge —
 * same deployment, same trust domain — and the policy handles row-level rules.
 *
 * Three doors, one authority: /api (the sync protocol), /apps (files served
 * from the platform's entities), /mcp (the agent surface). All three arrive
 * with the same verified actor and go through the same TripleServer.
 */
import type { DurableObjectState } from "@cloudflare/workers-types";
import { TripleServer } from "triple-sdk/server";
import { DurableStorage } from "triple-sdk/server/durable";
import { createFetchHandler } from "triple-sdk/server/fetch";
import { createPlatform, handleMcp, serveApp, type Platform } from "workspace-platform";
import { schema, User } from "app-schema";
import { inviteMember, type Env } from "./auth.ts";
import { accessRules, policy } from "./policy.ts";

export class WorkspaceCell {
  readonly #server: TripleServer;
  readonly #platform: Platform;
  readonly #handle: (request: Request) => Promise<Response>;
  readonly #env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.#env = env;
    this.#server = new TripleServer({
      schema,
      policy,
      storage: new DurableStorage(state.storage),
      retainLog: 10_000,
    });
    this.#platform = createPlatform({ server: this.#server, schema });
    this.#handle = createFetchHandler(
      this.#server,
      (request) => request.headers.get("x-actor"),
    );
  }

  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const org = /^\/w\/([\w-]+)/.exec(url.pathname)?.[1] ?? "org_dev";
    const workspacePath = url.pathname.replace(/^\/w\/[\w-]+/, "");
    const actor = request.headers.get("x-actor") ?? "anonymous";

    // Mirror the caller's identity — name, email, ROLE — into their User row on
    // every request. One lookup when nothing changed; a commit when it did. This
    // is what makes `ctx.actor.role` data the policy can read. Anonymous callers
    // have no row: their actor record is `{ id }`, and every rule denies it.
    this.#ensureUser(request);

    if (workspacePath === "/mcp") {
      return handleMcp(request, {
        platform: this.#platform,
        actor,
        appBase: url.pathname.replace(/\/mcp$/, "/apps"),
        accessRules,
        inviteMember: (email, role) => inviteMember(this.#env, org, email, role),
      });
    }

    // …/apps/<name> → …/apps/<name>/ so an app's relative imports resolve.
    if (/^\/apps\/[\w-]+(\/draft)?$/.test(workspacePath)) {
      return Promise.resolve(Response.redirect(`${url.origin}${url.pathname}/`, 308));
    }
    if (workspacePath.startsWith("/apps/")) {
      return Promise.resolve(serveApp(this.#platform, actor, workspacePath.slice("/apps".length)));
    }

    return this.#handle(request);
  }

  #ensureUser(request: Request): void {
    const actor = request.headers.get("x-actor");
    const name = request.headers.get("x-actor-name");
    const email = request.headers.get("x-actor-email") ?? undefined;
    const claimed = request.headers.get("x-actor-role");
    const role = claimed === "admin" || claimed === "member" || claimed === "guest" ? claimed : undefined;
    if (!actor || actor === "anonymous" || !name || !role) return;
    const held = (predicate: string) => this.#server.storage.match([actor, predicate, undefined])[0]?.[2];
    if (held("user/name") === name && held("user/role") === role && held("user/email") === email) return;
    // The cell's own commit path: write checks are bypassed here on purpose —
    // `role` is exactly the field no client may write (policy.ts).
    const tx = this.#server.transaction();
    const draft = tx.edit(User, actor);
    draft.name = name;
    draft.role = role;
    draft.email = email;
    this.#server.commit(tx, actor);
  }
}
