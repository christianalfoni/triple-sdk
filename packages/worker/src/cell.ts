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
 *
 * The cell also owns its SCHEMA (§4.9): the fixed entities are code, the
 * declared ones are a JSON document in this cell's SQLite. `set_schema`
 * validates, refuses breaking changes, persists a new generation, and reloads
 * the server in place — every earlier generation stays accepted, so apps built
 * against them keep working. `/schema.js` serves the whole thing to browsers.
 */
import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import { Query, runQuery } from "triple-sdk/query";
import type { EntityDef } from "triple-sdk/schema";
import { TripleServer } from "triple-sdk/server";
import { DurableStorage } from "triple-sdk/server/durable";
import { createFetchHandler } from "triple-sdk/server/fetch";
import {
  EMPTY_DECLARATION,
  buildWorkspace,
  createPlatform,
  handleMcp,
  migrationProblems,
  schemaModule,
  serveApp,
  validateDeclaration,
  type Platform,
  type WorkspaceDeclaration,
} from "workspace-platform";
import { platform as platformEntities, schema as fixedSchema, User } from "app-schema";
import { inviteMember, type Env } from "./auth.ts";

export class WorkspaceCell {
  readonly #state: DurableObjectState;
  readonly #env: Env;
  #sql!: SqlStorage;
  #storage!: DurableStorage;
  #server!: TripleServer;
  #handle!: (request: Request) => Promise<Response>;
  #platform!: Platform;
  #declaration!: WorkspaceDeclaration;
  /** Every generation this workspace has run, oldest first — all stay accepted. */
  #generations!: string[];

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
    this.#boot();
  }

  /** Everything the cell holds derives from its storage; a reset re-runs this. */
  #boot(): void {
    this.#sql = this.#state.storage.sql;
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS workspace_schema (generation TEXT PRIMARY KEY, declaration TEXT NOT NULL, at INTEGER NOT NULL)",
    );
    const rows = this.#sql
      .exec("SELECT generation, declaration FROM workspace_schema ORDER BY at ASC")
      .toArray() as unknown as { generation: string; declaration: string }[];
    this.#generations = rows.map((row) => row.generation);
    const latest = rows[rows.length - 1];
    this.#declaration = latest ? (JSON.parse(latest.declaration) as WorkspaceDeclaration) : EMPTY_DECLARATION;

    this.#storage = new DurableStorage(this.#state.storage);
    const workspace = buildWorkspace({ User, platform: platformEntities, declaration: this.#declaration });
    this.#server = new TripleServer({
      schema: workspace.schema,
      policy: workspace.policy,
      storage: this.#storage,
      retainLog: 10_000,
      compatibleSchemas: this.#compatible(),
    });
    this.#platform = createPlatform({ server: this.#server, schema: workspace.schema, declaration: this.#declaration });
    this.#handle = createFetchHandler(this.#server, (request) => request.headers.get("x-actor"));
  }

  /** The console speaks the fixed schema alone; every earlier generation stays accepted (§7.3). */
  #compatible(): string[] {
    return [fixedSchema.hash, ...this.#generations];
  }

  /** set_schema: validate → refuse breaking changes → build → persist → reload in place. */
  #setSchema(input: unknown): { generation: string; entities: string[] } {
    const declaration = validateDeclaration(input);
    const problems = migrationProblems(this.#declaration, declaration, this.#storage);
    if (problems.length > 0) throw new Error(problems.join("\n"));
    const workspace = buildWorkspace({ User, platform: platformEntities, declaration }); // throws with the reason
    const generation = workspace.schema.hash;
    this.#sql.exec(
      "INSERT OR REPLACE INTO workspace_schema (generation, declaration, at) VALUES (?, ?, ?)",
      generation,
      JSON.stringify(declaration),
      Date.now(),
    );
    if (!this.#generations.includes(generation)) this.#generations.push(generation);
    this.#declaration = declaration;
    this.#server.reload({ schema: workspace.schema, policy: workspace.policy, compatibleSchemas: this.#compatible() });
    this.#platform = createPlatform({ server: this.#server, schema: workspace.schema, declaration });
    return { generation, entities: Object.keys(declaration.entities) };
  }

  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const org = /^\/w\/([\w-]+)/.exec(url.pathname)?.[1] ?? "org_dev";
    const workspacePath = url.pathname.replace(/^\/w\/[\w-]+/, "");
    const actor = request.headers.get("x-actor") ?? "anonymous";
    const schemaUrl = `/w/${org}/schema.js`;

    // Mirror the caller's identity — name, email, ROLE — into their User row on
    // every request. One lookup when nothing changed; a commit when it did. This
    // is what makes `ctx.actor.role` data the policy can read. Anonymous callers
    // have no row: their actor record is `{ id }`, and every rule denies it.
    this.#ensureUser(request);

    // The operator plane — the edge admits it only with the service secret and
    // marks it so; no member ever reaches this. Bypasses every rule on purpose.
    if (workspacePath === "/ops") {
      if (request.headers.get("x-operator") !== "1") return Promise.resolve(json(403, { error: "operators only" }));
      return this.#ops(request);
    }

    // §4.9 — this workspace's schema, as a browser module. Shape is not secret
    // within a workspace, and public apps need it too, so anyone may read it.
    if (workspacePath === "/schema.js") {
      return Promise.resolve(
        new Response(schemaModule(this.#platform.schema), {
          headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
        }),
      );
    }

    if (workspacePath === "/mcp") {
      return handleMcp(request, {
        platform: this.#platform,
        actor,
        appBase: new URL(url.pathname.replace(/\/mcp$/, "/apps"), url).toString(),
        inviteMember: (email, role) => inviteMember(this.#env, org, email, role),
        setSchema: (declaration) => this.#setSchema(declaration),
      });
    }

    // Who am I, IN THIS WORKSPACE — the edge's verified headers, as the cell
    // sees them. Anonymous callers get a 401 so an app can offer sign-in.
    if (workspacePath === "/api/me") {
      if (actor === "anonymous") return Promise.resolve(json(401, { error: "sign in first", actor: "anonymous" }));
      return Promise.resolve(
        json(200, {
          actor,
          name: request.headers.get("x-actor-name"),
          email: request.headers.get("x-actor-email") ?? undefined,
          role: request.headers.get("x-actor-role"),
        }),
      );
    }

    // …/apps/<name> → …/apps/<name>/ so an app's relative imports resolve.
    if (/^\/apps\/[\w-]+(\/draft)?$/.test(workspacePath)) {
      return Promise.resolve(Response.redirect(`${url.origin}${url.pathname}/`, 308));
    }
    if (workspacePath.startsWith("/apps/")) {
      return Promise.resolve(serveApp(this.#platform, actor, workspacePath.slice("/apps".length), schemaUrl));
    }

    return this.#handle(request);
  }

  /**
   * Raw reads, deletes and resets that go around the policy — for debugging
   * and cleanup (`pnpm ops`). Deletes go through a real transaction, so
   * inbound refs are swept and connected clients see the removals live.
   */
  async #ops(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown> & { command?: string };
    const schema = this.#platform.schema;
    const entities = schema.entities as Record<string, EntityDef>;
    const subjectsOf = (entity: string): string[] => {
      const prefix = `${entity}_`;
      const seen = new Set<string>();
      for (const [subject] of this.#storage.snapshot().triples) if (subject.startsWith(prefix)) seen.add(subject);
      return [...seen];
    };
    const rows = (name: string, where: Record<string, unknown> = {}) => {
      const entity = entities[name];
      if (!entity) throw new Error(`no entity "${name}" — one of: ${Object.keys(entities).join(", ")}`);
      let query = Query.from(entity);
      for (const [field, raw] of Object.entries(where)) {
        const builder = entity[field];
        if (!builder) throw new Error(`"${name}" has no field "${field}"`);
        const value = builder.field.type === "ref" && typeof raw === "string" ? { id: raw } : raw;
        query = query.where(field as never, value as never);
      }
      const selection = Object.fromEntries(Object.keys(entity).map((field) => [field, true]));
      return runQuery(this.#storage, schema.flat, query.select(selection as never)) as Record<string, unknown>[];
    };
    const remove = (ids: string[]): { deleted: number; version: number } => {
      const tx = this.#server.transaction();
      for (const id of ids) tx.delete(id);
      const entry = this.#server.commit(tx, "operator");
      return { deleted: ids.length, version: entry?.version ?? this.#storage.version };
    };
    try {
      switch (body.command) {
        case "info":
          return json(200, {
            generation: this.#server.schemaHash,
            generations: this.#generations,
            declaration: this.#declaration,
            version: this.#storage.version,
            counts: Object.fromEntries(Object.keys(entities).map((name) => [name, subjectsOf(name).length])),
            apps: rows("app").map((app) => app.name),
          });
        case "schema":
          return json(200, this.#declaration);
        case "set-schema":
          return json(200, this.#setSchema(body.declaration));
        case "query":
          return json(200, rows(String(body.entity), (body.where as Record<string, unknown>) ?? {}));
        case "triples": {
          const subject = typeof body.subject === "string" ? body.subject : undefined;
          const limit = typeof body.limit === "number" ? body.limit : 500;
          return json(200, this.#storage.match([subject, undefined, undefined]).slice(0, limit));
        }
        case "log": {
          const since = typeof body.since === "number" ? body.since : Math.max(0, this.#storage.version - 20);
          return json(200, this.#storage.entriesSince(since) ?? { compacted: true, floorAbove: since });
        }
        case "delete":
          return json(200, remove(Array.isArray(body.ids) ? (body.ids as string[]) : []));
        case "purge":
          return json(200, { entity: body.entity, ...remove(subjectsOf(String(body.entity))) });
        case "delete-app": {
          const app = rows("app", { name: String(body.name) })[0];
          if (!app) return json(404, { error: `no app "${body.name}"` });
          const releases = rows("release", { app: String(app.id) });
          const files = releases.flatMap((release) => rows("releaseFile", { release: String(release.id) }));
          const drafts = rows("draftFile", { app: String(app.id) });
          const ids = [...files, ...releases, ...drafts, app].map((row) => String(row.id));
          return json(200, { app: body.name, releases: releases.length, files: files.length, drafts: drafts.length, ...remove(ids) });
        }
        case "reset":
          // Everything — triples, log, schema generations. The cell reboots from
          // nothing; connected clients must reconnect (their streams die with the
          // old server). For dev and demos.
          await this.#state.storage.deleteAll();
          this.#boot();
          return json(200, { reset: true, generation: this.#server.schemaHash, version: this.#storage.version });
        default:
          return json(400, { error: `unknown command "${body.command}"` });
      }
    } catch (cause) {
      return json(400, { error: (cause as Error).message });
    }
  }

  #ensureUser(request: Request): void {
    const actor = request.headers.get("x-actor");
    const name = request.headers.get("x-actor-name");
    const email = request.headers.get("x-actor-email") ?? undefined;
    const claimed = request.headers.get("x-actor-role");
    const role = claimed === "admin" || claimed === "member" || claimed === "appUser" ? claimed : undefined;
    if (!actor || actor === "anonymous" || !name || !role) return;
    const held = (predicate: string) => this.#server.storage.match([actor, predicate, undefined])[0]?.[2];
    if (held("user/name") === name && held("user/role") === role && held("user/email") === email) return;
    // The cell's own commit path: write checks are bypassed here on purpose —
    // `role` is exactly the field no client may write (the fixed user rule).
    const tx = this.#server.transaction();
    const draft = tx.edit(User, actor);
    draft.name = name;
    draft.role = role;
    draft.email = email;
    this.#server.commit(tx, actor);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
