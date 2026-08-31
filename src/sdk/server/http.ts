/**
 * The HTTP transport binding.
 *
 * Kept separate from TripleServer on purpose: the SDK's server logic is
 * message-in/message-out, and this file is the only thing in the SDK that knows about
 * Node's http module. Replacing it with a WebSocket binding for realtime (SPEC §7)
 * means writing a sibling file, not editing TripleServer.
 *
 *   POST /api/query      → QueryResultMessage
 *   POST /api/transact   → AckMessage | RejectMessage
 *   GET  /api/subscribe  → text/event-stream of DeltaMessage (SPEC §7.7)
 *
 * It is also where identity lives (SPEC §7.4). The transport authenticated the
 * connection, so the transport — not the message body — says who is writing.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { SchemaMismatchError } from "../shared/protocol.ts";
import type { BroadcastMessage, QueryMessage, TransactMessage } from "../shared/protocol.ts";
import type { Id } from "../shared/types.ts";
import type { TripleServer } from "./server.ts";

/**
 * Derive the writer's identity from the request: a session cookie, a verified bearer
 * token, a mTLS peer certificate — whatever this deployment authenticates with.
 * Return null to reject the request as unauthenticated.
 */
export type ResolveActor = (req: IncomingMessage) => Id | null;

export function createHttpHandler(server: TripleServer, resolveActor: ResolveActor) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/api/subscribe") {
      const actor = resolveActor(req);
      if (actor === null) return json(res, 401, { error: "Not authenticated" });

      // Server-Sent Events over plain node:http — no dependency, and the wire
      // format is readable by eye: one `data:` line per DeltaMessage.
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(":connected\n\n");

      // `since` present → replay the backlog after that version first (§7.3).
      // Absent → live only: a fresh client gets state from its queries, not history.
      const sinceParam = url.searchParams.get("since");
      const since = sinceParam === null ? undefined : Number(sinceParam);

      const unsubscribe = server.subscribe(
        actor,
        (message) => {
          // Backpressure (§11.4): a reader that cannot keep up gets DROPPED, not
          // buffered without bound — reconnecting replays the log, so dropping is
          // safe by construction. The log makes the cheap option the correct one.
          if (res.writableLength > 1_000_000) {
            res.destroy();
            return;
          }
          res.write(`data: ${JSON.stringify(message)}\n\n`);
        },
        since,
      );

      // Pings keep proxies from timing out the idle stream — and double as the
      // session heartbeat: a revoked session's stream ends within one interval.
      const ping = setInterval(() => {
        if (resolveActor(req) === null) {
          res.end();
          return;
        }
        res.write(":ping\n\n");
      }, 25_000);
      req.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/broadcast") {
      const actor = resolveActor(req);
      if (actor === null) return json(res, 401, { error: "Not authenticated" });
      const body = await readBody(req);
      // §13 — ephemeral payloads fan to everyone; a large one is amplification.
      if (Buffer.byteLength(body) > 16_384) {
        return json(res, 413, { error: "Ephemeral payloads are capped at 16KB" });
      }
      try {
        const message = JSON.parse(body) as BroadcastMessage;
        server.broadcast(actor, message.payload, message.about);
        return json(res, 200, { ok: true });
      } catch {
        return json(res, 400, { error: "Malformed JSON body" });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/query") {
      const actor = resolveActor(req);
      if (actor === null) return json(res, 401, { error: "Not authenticated" });

      let message: QueryMessage;
      try {
        message = JSON.parse(await readBody(req)) as QueryMessage;
      } catch {
        return json(res, 400, { error: "Malformed JSON body" });
      }
      try {
        return json(res, 200, server.query(message, actor));
      } catch (cause) {
        if (cause instanceof SchemaMismatchError) {
          // §7.3 — refuse loudly rather than answer with predicates the other side
          // does not have (which reads as "no data").
          return json(res, 409, { error: cause.message, code: "schema-mismatch" });
        }
        throw cause;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/transact") {
      const actor = resolveActor(req);
      if (actor === null) {
        return json(res, 401, { error: "Not authenticated" });
      }

      let message: TransactMessage;
      try {
        message = JSON.parse(await readBody(req)) as TransactMessage;
      } catch {
        return json(res, 400, { error: "Malformed JSON body" });
      }
      // `actor` comes from here, not from `message` — the client cannot pick it.
      const result = server.transact(message, actor);
      if (result.kind === "reject" && result.reason.includes("different schema generation")) {
        return json(res, 409, { error: result.reason, code: "schema-mismatch" });
      }
      return json(res, 200, result);
    }

    json(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
