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
  readonly #sql: SqlStorage;
  readonly #storage: DurableStorage;
  readonly #server: TripleServer;
  readonly #handle: (request: Request) => Promise<Response>;
  readonly #env: Env;
  #platform: Platform;
  #declaration: WorkspaceDeclaration;
  /** Every generation this workspace has run, oldest first — all stay accepted. */
  readonly #generations: string[];

  constructor(state: DurableObjectState, env: Env) {
    this.#env = env;
    this.#sql = state.storage.sql;
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS workspace_schema (generation TEXT PRIMARY KEY, declaration TEXT NOT NULL, at INTEGER NOT NULL)",
    );
    const rows = this.#sql
      .exec("SELECT generation, declaration FROM workspace_schema ORDER BY at ASC")
      .toArray() as unknown as { generation: string; declaration: string }[];
    this.#generations = rows.map((row) => row.generation);
    const latest = rows[rows.length - 1];
    this.#declaration = latest ? (JSON.parse(latest.declaration) as WorkspaceDeclaration) : EMPTY_DECLARATION;

    this.#storage = new DurableStorage(state.storage);
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
