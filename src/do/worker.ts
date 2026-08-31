/**
 * SPEC §12 as a Cloudflare Worker: a CELL is a Durable Object.
 *
 * `idFromName(workspaceId)` replaces createCellHost — routing, placement,
 * elasticity and the single-writer invariant are the PLATFORM's job now. The
 * object builds the same TripleServer as the node demo, over the DurableStorage
 * adapter; the fetch binding serves the same four routes; the demo seed runs on
 * first touch of a fresh workspace. Everything above §5 is byte-identical.
 */

import type { DurableObjectState, DurableObjectNamespace } from "@cloudflare/workers-types";
import { TripleServer } from "../sdk/server/server.ts";
import { DurableStorage } from "../sdk/server/durable.ts";
import { createFetchHandler } from "../sdk/server/fetch.ts";
import { schema, DEMO_USER } from "../demo/shared/schema.ts";
import { policy } from "../demo/server/policy.ts";
import { seed } from "../demo/server/seed.ts";

type Env = { CELL: DurableObjectNamespace };

// The demo trusts a header for identity; production would verify a token here.
const resolveActor = (request: Request): string =>
  request.headers.get("x-actor") ?? DEMO_USER;

export class WorkspaceCell {
  readonly #handle: (request: Request) => Promise<Response>;

  constructor(state: DurableObjectState) {
    const server = new TripleServer({
      schema,
      policy,
      storage: new DurableStorage(state.storage),
      retainLog: 10_000,
    });
    if (server.storage.version === 0) seed(server);
    this.#handle = createFetchHandler(server, resolveActor);
  }

  fetch(request: Request): Promise<Response> {
    return this.#handle(request);
  }
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    // /w/<workspace>/api/* → that workspace's cell. One line of routing.
    const match = /^\/w\/([\w-]+)\/api\//.exec(new URL(request.url).pathname);
    if (!match) return new Response("expected /w/<workspace>/api/*", { status: 404 });
    const cell = env.CELL.get(env.CELL.idFromName(match[1]!));
    return cell.fetch(request as never) as unknown as Promise<Response>;
  },
};
