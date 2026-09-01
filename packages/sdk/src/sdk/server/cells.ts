/**
 * The cell host: one Node process serving MANY workspaces (§12).
 *
 * A cell is one workspace's entire backend — a TripleServer plus its own storage —
 * created lazily on first request and cached. Routing is by path:
 *
 *   /w/<workspace>/api/*  →  that workspace's cell  →  the ordinary HTTP handler
 *
 * The invariant that matters: ONE process owns a workspace at a time (the log's
 * single-writer guarantee). Scaling out is moving cells between processes at the
 * router above this host, never splitting one.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Id } from "../shared/types.ts";
import type { TripleServer } from "./server.ts";
import { createHttpHandler, type ResolveActor } from "./http.ts";

export type CellHostOptions = {
  /** Build a workspace's cell on first touch — its storage decides durability. */
  createCell: (workspace: string) => TripleServer;
  /** Authenticate a request FOR a workspace: membership checks belong here. */
  resolveActor: (req: IncomingMessage, workspace: string) => Id | null;
  /** Reject silly or hostile workspace ids before they reach the filesystem. */
  isWorkspaceId?: (workspace: string) => boolean;
};

const DEFAULT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function createCellHost(options: CellHostOptions) {
  const cells = new Map<string, ReturnType<typeof createHttpHandler>>();
  const valid = options.isWorkspaceId ?? ((ws: string) => DEFAULT_ID.test(ws));

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const match = /^\/w\/([^/]+)(\/api\/.*)$/.exec(req.url ?? "");
    if (!match || !valid(match[1]!)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "No such workspace route" }));
      return;
    }
    const [, workspace, rest] = match;

    let handler = cells.get(workspace!);
    if (!handler) {
      const cell = options.createCell(workspace!);
      const resolveActor: ResolveActor = (r) => options.resolveActor(r, workspace!);
      handler = createHttpHandler(cell, resolveActor);
      cells.set(workspace!, handler);
    }

    // The cell's handler sees workspace-relative URLs, same as standalone.
    req.url = rest;
    return handler(req, res);
  };
}
