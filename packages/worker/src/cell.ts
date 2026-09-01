/**
 * §12 — the CELL: one workspace = one Durable Object = one SQLite file. The
 * edge (index.ts) has already authenticated the request and checked org
 * membership; the verified identity arrives as headers the edge itself set
 * (client-supplied ones are stripped there). Inside, the cell trusts the edge —
 * same deployment, same trust domain — and the policy handles row-level rules.
 */
import type { DurableObjectState } from "@cloudflare/workers-types";
import { TripleServer } from "triple-sdk/server";
import { DurableStorage } from "triple-sdk/server/durable";
import { createFetchHandler } from "triple-sdk/server/fetch";
import { schema, User } from "app-schema";
import { policy } from "./policy.ts";
import { AppFiles, contentType } from "./files.ts";
import { handleMcp } from "./mcp.ts";
import { shell } from "./shell.ts";

export class WorkspaceCell {
  readonly #server: TripleServer;
  readonly #files: AppFiles;
  readonly #handle: (request: Request) => Promise<Response>;

  constructor(state: DurableObjectState) {
    this.#server = new TripleServer({
      schema,
      policy,
      storage: new DurableStorage(state.storage),
      retainLog: 10_000,
    });
    this.#files = new AppFiles(state.storage.sql);
    this.#handle = createFetchHandler(
      this.#server,
      (request) => request.headers.get("x-actor"),
    );
  }

  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const workspacePath = url.pathname.replace(/^\/w\/[\w-]+/, "");

    // §MCP — the developer surface, scoped to THIS workspace's cell.
    if (workspacePath === "/mcp") {
      const base = url.pathname.replace(/\/mcp$/, "/apps");
      return handleMcp(request, this.#server, this.#files,
        request.headers.get("x-actor") ?? "user_dev", base);
    }

    // Apps: files written through MCP, served with the implicit shell.
    const appMatch = /^\/apps\/([\w-]+)\/(.*)$/.exec(workspacePath);
    if (appMatch) {
      const [, app, rest] = appMatch;
      const path = rest === "" ? "index.html" : rest!;
      const content = this.#files.read(app!, path);
      if (content !== null) {
        return Promise.resolve(new Response(content, { headers: { "content-type": contentType(path) } }));
      }
      if (path === "index.html" && this.#files.list(app!).length > 0) {
        return Promise.resolve(new Response(shell(app!), { headers: { "content-type": "text/html; charset=utf-8" } }));
      }
      return Promise.resolve(new Response("no such app or file", { status: 404 }));
    }

    // Mirror the member's profile into the workspace on every subscribe, so
    // `owner: { name }` selections resolve without the app writing users.
    if (new URL(request.url).pathname.endsWith("/subscribe")) {
      this.#ensureUser(
        request.headers.get("x-actor"),
        request.headers.get("x-actor-name"),
        request.headers.get("x-actor-email"),
      );
    }
    return this.#handle(request);
  }

  #ensureUser(actor: string | null, name: string | null, email: string | null): void {
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
