/**
 * SPEC §7 — the fetch-native transport binding: the same four routes http.ts
 * serves with node:http, spoken in Request/Response — which is what a
 * Cloudflare Worker (or any WinterCG runtime) hands us. `TripleServer` stays
 * transport-agnostic; this file, like http.ts, only translates.
 *
 * The delta stream stays SSE (a streamed Response): it keeps the CLIENT
 * identical across node and workers — HttpTransport already speaks it.
 */

import type { TripleServer } from "./server.ts";
import { SchemaMismatchError } from "../shared/protocol.ts";
import type { BroadcastMessage, QueryMessage, TransactMessage } from "../shared/protocol.ts";
import type { Id } from "../shared/types.ts";

export type ResolveFetchActor = (request: Request) => Id | null;

export function createFetchHandler(server: TripleServer, resolveActor: ResolveFetchActor) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = url.pathname.slice(url.pathname.lastIndexOf("/api/") + 4);
    const actor = resolveActor(request);
    if (actor === null) return json(401, { error: "Who are you?" });

    try {
      if (request.method === "POST" && route === "/query") {
        return json(200, server.query((await request.json()) as QueryMessage, actor));
      }
      if (request.method === "POST" && route === "/transact") {
        return json(200, server.transact((await request.json()) as TransactMessage, actor));
      }
      if (request.method === "POST" && route === "/broadcast") {
        const body = await request.text();
        if (body.length > 16_384) return json(413, { error: "Ephemeral payloads are capped at 16KB" });
        server.broadcast(actor, (JSON.parse(body) as BroadcastMessage).payload,
          (JSON.parse(body) as BroadcastMessage).about);
        return json(200, { ok: true });
      }
      if (request.method === "GET" && route === "/subscribe") {
        return subscribe(server, actor, url);
      }
    } catch (cause) {
      if (cause instanceof SchemaMismatchError) {
        return json(409, { error: cause.message });
      }
      throw cause;
    }
    return json(404, { error: `No such route: ${route}` });
  };
}

/** SSE over a streamed Response. The DO stays pinned while the stream is open. */
function subscribe(server: TripleServer, actor: Id, url: URL): Response {
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam === null ? undefined : Number(sinceParam);
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (message: unknown): void => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
        } catch {
          unsubscribe?.();
          clearInterval(ping);
        }
      };
      unsubscribe = server.subscribe(actor, send, since);
      ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          unsubscribe?.();
          clearInterval(ping);
        }
      }, 15_000);
    },
    cancel() {
      unsubscribe?.();
      clearInterval(ping);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
