/**
 * The platform over a workspace cell: apps, drafts and releases as ENTITIES,
 * read and written through the SAME two paths every client uses —
 * `server.query` and `server.transact`, as the actor, policy-checked and
 * fanned out. There is no file store and no second permission system; an
 * editor app can watch drafts change live, a launcher app can list apps,
 * because they are rows like any other.
 *
 * Reads here are server-side: they hit the cell's own storage and never cross
 * the wire, but they still pass through the policy read filter, so "who can
 * open an app" is exactly "who can read its App row".
 */
import type { TripleServer } from "triple-sdk/server";
import { subjectEntityName, type AppSchema, type EntityDef } from "triple-sdk/schema";
import {
  Query,
  runQuery,
  toPayload,
  type EntityResult,
  type QueryBuilder,
} from "triple-sdk/query";
import { MemoryStorage } from "triple-sdk/storage";
import type { Transaction } from "triple-sdk/transaction";
import { platformEntitiesOf } from "./schema.ts";
import { shell } from "./shell.ts";

export type Platform = ReturnType<typeof createPlatform>;

export type Served = { status: number; body: string; contentType: string };

export function createPlatform(options: { server: TripleServer; schema: AppSchema }) {
  const { server, schema } = options;
  const entities = platformEntitiesOf(schema);
  const { app: App, draftFile: DraftFile, release: Release, releaseFile: ReleaseFile } = entities;
  let mutations = 0;

  /**
   * Read AS the actor — the path an app takes: `server.query` returns the
   * permission-filtered triples, and the rows are built from those, the same
   * way a client builds them.
   */
  function queryAs<E extends EntityDef, Sel>(
    actor: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: QueryBuilder<E, Sel, any>,
  ): EntityResult<E, Sel>[] {
    const payload = toPayload(query);
    const result = server.query({ kind: "query", schema: server.schemaHash, payload }, actor);
    const cache = new MemoryStorage();
    cache.apply({ added: result.triples, removed: [] }, actor);
    return runQuery(cache, schema.flat, query);
  }

  /**
   * Write AS the actor — policy-checked like any client transaction, and
   * fanned out to subscribers like any commit (a live editor sees the draft
   * change). Rejections surface as errors with the policy's reason.
   */
  function transactAs(actor: string, build: (tx: Transaction) => void): void {
    const tx = server.transaction();
    build(tx);
    const { operations } = tx.build();
    const outcome = server.transact(
      {
        kind: "transact",
        schema: server.schemaHash,
        mutationId: `platform_${++mutations}`,
        operations,
      },
      actor,
    );
    if (outcome.kind === "reject") throw new Error(outcome.reason);
  }

  const appSelection = { name: true, audience: true, invited: true, live: { version: true } } as const;

  /** The app, IF this actor may open it — the App's read rule decides (see policy.ts). */
  const appByName = (actor: string, name: string) =>
    queryAs(actor, Query.from(App).where("name", name).select(appSelection))[0];

  /** No constraint: every app this actor may open (§6.2). */
  const apps = (actor: string) => queryAs(actor, Query.from(App).orderBy("name").select(appSelection));

  /**
   * The actor's own record — role and email as the cell holds them. Read the
   * same way as everything else, so an actor with no row yet is just `{ id }`.
   */
  function actorRecord(actor: string): { id: string; role?: string; email?: string } {
    const entity = (schema.entities as Record<string, EntityDef>)[subjectEntityName(actor)];
    if (!entity) return { id: actor };
    const [row] = queryAs(actor, Query.from(entity).whereId(actor).select({ role: true, email: true } as never));
    return (row ?? { id: actor }) as { id: string; role?: string; email?: string };
  }

  const drafts = (actor: string, app: { id: string }) =>
    queryAs(
      actor,
      Query.from(DraftFile).where("app", { id: app.id }).orderBy("path").select({ path: true, content: true }),
    );

  const draft = (actor: string, app: { id: string }, path: string) =>
    queryAs(
      actor,
      Query.from(DraftFile).where("app", { id: app.id }).where("path", path).select({ path: true, content: true }),
    )[0];

  const releaseFiles = (actor: string, release: { id: string }) =>
    queryAs(
      actor,
      Query.from(ReleaseFile).where("release", { id: release.id }).orderBy("path").select({ path: true, content: true }),
    );

  /** Create or replace one draft file. The app row is created on first write. */
  function writeDraft(actor: string, appName: string, path: string, content: string): void {
    // Check-then-act is safe: a cell is single-threaded (§12), so no second
    // writer can slip a duplicate (app, path) in between.
    const existing = appByName(actor, appName);
    const current = existing ? draft(actor, existing, path) : undefined;
    transactAs(actor, (tx) => {
      // A new app starts members-only; widening its audience is a separate, deliberate step.
      const appId = existing?.id ?? tx.create(App, { name: appName, audience: "members" }).id;
      if (current) tx.edit(DraftFile, current.id).content = content;
      else tx.create(DraftFile, { app: { id: appId }, path, content });
    });
  }

  /** Who may open the app: "members" (default), "invited" (+ listed app users), "public" (anyone). */
  function setAudience(actor: string, appName: string, audience: "members" | "invited" | "public"): void {
    const app = appByName(actor, appName);
    if (!app) throw new Error(`no app "${appName}"`);
    transactAs(actor, (tx) => {
      tx.edit(App, app.id).audience = audience;
    });
  }

  /** Admit one app user, by email — matched against the email the identity provider verified. */
  function inviteToApp(actor: string, appName: string, email: string): { invited: readonly string[] } {
    const app = appByName(actor, appName);
    if (!app) throw new Error(`no app "${appName}"`);
    if (!app.invited.includes(email)) {
      transactAs(actor, (tx) => {
        tx.edit(App, app.id).invited.push(email);
      });
    }
    return { invited: [...app.invited, ...(app.invited.includes(email) ? [] : [email])] };
  }

  /** Take the app off its live URL. Releases stay — history is permanent; publish again to restore. */
  function unpublish(actor: string, appName: string): void {
    const app = appByName(actor, appName);
    if (!app) throw new Error(`no app "${appName}"`);
    transactAs(actor, (tx) => {
      tx.edit(App, app.id).live = undefined;
    });
  }

  function deleteDraft(actor: string, appName: string, path: string): boolean {
    const app = appByName(actor, appName);
    const current = app ? draft(actor, app, path) : undefined;
    if (!current) return false;
    transactAs(actor, (tx) => {
      tx.delete(current.id);
    });
    return true;
  }

  /**
   * Publish = ONE transaction: a Release, a ReleaseFile per draft, and the
   * app's `live` pointer moved. Nothing is visible on the live channel until
   * the pointer moves, so publish is atomic by the pointer even if the file
   * set were ever written across several transactions.
   */
  function publish(actor: string, appName: string): { version: number } {
    const app = appByName(actor, appName);
    if (!app) throw new Error(`no app "${appName}" — write a file first`);
    const files = drafts(actor, app);
    if (files.length === 0) throw new Error(`"${appName}" has no draft files to publish`);
    const previous = queryAs(actor, Query.from(Release).where("app", { id: app.id }).select({ version: true }));
    const version = previous.reduce((max, release) => Math.max(max, release.version), 0) + 1;
    transactAs(actor, (tx) => {
      const release = tx.create(Release, {
        app: { id: app.id },
        version,
        schemaGeneration: server.schemaHash,
        publishedBy: { id: actor },
        publishedAt: Date.now(),
      });
      for (const file of files) {
        tx.create(ReleaseFile, { release: { id: release.id }, path: file.path, content: file.content });
      }
      tx.edit(App, app.id).live = { id: release.id };
    });
    return { version };
  }

  /**
   * Serve one file of an app on one channel. The live channel reads the
   * release `App.live` points at; the draft channel reads DraftFiles. An app
   * with files but no index.html gets the implicit shell.
   */
  function serve(actor: string, appName: string, channel: "live" | "draft", path: string): Served {
    const app = appByName(actor, appName);
    if (!app) return { status: 404, body: `no app "${appName}"`, contentType: "text/plain" };
    let files: { path: string; content: string }[];
    if (channel === "draft") {
      files = drafts(actor, app);
    } else {
      if (!app.live) {
        return {
          status: 404,
          body: `"${appName}" is not published yet — the draft is served under ./draft/`,
          contentType: "text/plain",
        };
      }
      files = releaseFiles(actor, app.live);
    }
    const wanted = path === "" ? "index.html" : path;
    const file = files.find((candidate) => candidate.path === wanted);
    if (file) return { status: 200, body: file.content, contentType: contentType(wanted) };
    if (wanted === "index.html" && files.length > 0) {
      return { status: 200, body: shell(appName), contentType: "text/html; charset=utf-8" };
    }
    return { status: 404, body: `no file "${wanted}" in ${appName} (${channel})`, contentType: "text/plain" };
  }

  return {
    server,
    schema,
    entities,
    queryAs,
    transactAs,
    actorRecord,
    apps,
    appByName,
    drafts,
    draft,
    writeDraft,
    deleteDraft,
    publish,
    unpublish,
    setAudience,
    inviteToApp,
    serve,
  };
}

export function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "html":
      return "text/html; charset=utf-8";
    case "js":
    case "mjs":
      return "text/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "json":
      return "application/json";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    default:
      return "text/plain; charset=utf-8";
  }
}
