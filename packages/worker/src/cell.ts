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

export class WorkspaceCell {
  readonly #server: TripleServer;
  readonly #handle: (request: Request) => Promise<Response>;

  constructor(state: DurableObjectState) {
    this.#server = new TripleServer({
      schema,
      policy,
      storage: new DurableStorage(state.storage),
      retainLog: 10_000,
    });
    this.#handle = createFetchHandler(
      this.#server,
      (request) => request.headers.get("x-actor"),
    );
  }

  fetch(request: Request): Promise<Response> {
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
