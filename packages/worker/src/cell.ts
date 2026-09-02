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
import { accessRules, policy } from "./policy.ts";

export class WorkspaceCell {
  readonly #server: TripleServer;
  readonly #platform: Platform;
  readonly #handle: (request: Request) => Promise<Response>;

  constructor(state: DurableObjectState) {
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
    const workspacePath = url.pathname.replace(/^\/w\/[\w-]+/, "");
    const actor = request.headers.get("x-actor") ?? "user_dev";

    if (workspacePath === "/mcp") {
      this.#ensureUser(request);
      return handleMcp(request, {
        platform: this.#platform,
        actor,
        appBase: url.pathname.replace(/\/mcp$/, "/apps"),
        accessRules,
      });
    }

    // …/apps/<name> → …/apps/<name>/ so an app's relative imports resolve.
    if (/^\/apps\/[\w-]+(\/draft)?$/.test(workspacePath)) {
      return Promise.resolve(Response.redirect(`${url.origin}${url.pathname}/`, 308));
    }
    if (workspacePath.startsWith("/apps/")) {
      return Promise.resolve(serveApp(this.#platform, actor, workspacePath.slice("/apps".length)));
    }

    // Mirror the member's profile into the workspace on every subscribe, so
    // `owner: { name }` selections resolve without the app writing users.
    if (workspacePath.endsWith("/subscribe")) this.#ensureUser(request);
    return this.#handle(request);
  }

  #ensureUser(request: Request): void {
    const actor = request.headers.get("x-actor");
    const name = request.headers.get("x-actor-name");
    const email = request.headers.get("x-actor-email");
    if (!actor || !name) return;
    const current = this.#server.storage.match([actor, "user/name", undefined])[0]?.[2];
    if (current === name) return;
    const tx = this.#server.transaction();
    const draft = tx.edit(User, actor);
    draft.name = name;
    if (email) draft.email = email;
    this.#server.commit(tx, actor);
  }
}
