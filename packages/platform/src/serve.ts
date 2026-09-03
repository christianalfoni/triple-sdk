/**
 * HTTP for apps — two URL spaces under …/apps/<name>/:
 *
 *   …/apps/<name>/<path>          the LIVE release, what members see
 *   …/apps/<name>/draft/<path>    the DRAFT, what write_file edits
 *
 * Path-based rather than a query flag, so an app's relative imports
 * (`./app.js`) resolve inside the right channel. `draft/` is therefore a
 * reserved segment inside an app's URL space.
 */
import type { Platform } from "./platform.ts";

/** `appsPath` is everything after `/apps`, e.g. `/hello/draft/app.js`; `schemaUrl` is this workspace's schema module. */
export function serveApp(platform: Platform, actor: string, appsPath: string, schemaUrl: string): Response {
  const match = /^\/([\w-]+)\/(?:draft(?:\/(.*))?|(.*))$/.exec(appsPath);
  if (!match) return new Response("expected …/apps/<name>/", { status: 404 });
  const [, name, draftPath, livePath] = match;
  const channel = draftPath !== undefined || /^\/[\w-]+\/draft$/.test(appsPath) ? "draft" : "live";
  const path = channel === "draft" ? (draftPath ?? "") : (livePath ?? "");
  const served = platform.serve(actor, name!, channel, path, schemaUrl);
  return new Response(served.body, {
    status: served.status,
    headers: { "content-type": served.contentType },
  });
}
