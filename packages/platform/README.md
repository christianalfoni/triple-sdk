# workspace-platform

Apps as data over a workspace cell. A coding agent connects to a workspace over
MCP, writes files, and publishes; members open the app at a URL. Under the
hood there is no file store and no second permission system: apps, their draft
files and their releases are **entities in the workspace schema**, read and
written through the same `query` and `transact` paths every client uses —
as the member, policy-checked, fanned out live.

```
packages/platform/src/
  schema.ts     the entities — App · DraftFile · Release · ReleaseFile   (shared shape)
  policy.ts     their rules                                              (server only)
  platform.ts   createPlatform(): drafts, publish, serve — over TripleServer
  mcp.ts        the MCP endpoint (JSON-RPC over HTTP)
  serve.ts      HTTP for …/apps/<name>/ and …/apps/<name>/draft/
  shell.ts      the implicit index.html (Tailwind + import map + Preact/htm)
```

## The model

```ts
App          { name: string, live?: ref(Release) }                  // the registry row; `live` = what members see
DraftFile    { app: ref(App), path: string, content: string }       // the agent's workbench — write_file edits these
Release      { app: ref(App), version: number, schemaGeneration: string, publishedBy: ref(User), publishedAt: number }
ReleaseFile  { release: ref(Release), path: string, content: string }   // a frozen copy of one draft at publish time
```

**Publish is one transaction:** a `Release` (version = max + 1, stamped with
the schema generation it was built against), a `ReleaseFile` per draft, and
`App.live` repointed. Nothing is visible on the live channel until the pointer
moves, so publish is atomic by the pointer.

**Releases are copies, not log history.** The SDK's log is compacted
(`retainLog`), so a published version has to survive as *state*. "Serve version
12" is a query, not a replay. Unchanged files are duplicated across releases on
purpose — KB-scale strings in SQLite do not warrant content addressing.

**Immutability is policy.** `Release` and `ReleaseFile` have `update` and
`delete` rules that never grant; there is no frozen flag. Rollback is
publishing again (or repointing `live`). One consequence: an app that has ever
been published cannot be deleted — its releases reference it, and required refs
may not dangle.

**Rules, v1:** any workspace member may create apps, edit drafts, and publish.
The edge has already proved membership; per-app ownership and audiences are
more rules in the same vocabulary, not new machinery.

Because they are entities, apps are queryable like anything else — a launcher
app lists apps with `Query.from(App)`, an editor app watches drafts change
live, and a running app watches its own row:

```js
const version = useQuery(
  () => Query.from(App).where("name", "hello").select({ live: { version: true } }), []);
// re-renders when someone publishes → "a new version is available — refresh"
```

## URLs and the shell

Two URL spaces per app, path-based so relative imports (`./app.js`) resolve
inside the right channel (`draft/` is therefore reserved inside an app):

```
…/apps/<name>/            the LIVE release — 404 "not published yet" until the first publish
…/apps/<name>/draft/      the DRAFT — what write_file just wrote
```

A request for `…/apps/<name>` without a trailing slash is redirected (308).
Any file the app wrote is served with a content type from its extension. An
app that has files but no `index.html` gets the implicit shell:

| import specifier | resolves to |
|---|---|
| `triple-sdk/client` · `/query` · `/react` · `/schema` | `/platform/sdk.js` — ONE bundle, one module instance, so `instanceof` and the `Schema` registry hold |
| `schema` | `/platform/schema.js` — the workspace's entities, incl. `App`, `Release` |
| `react` · `react/jsx-runtime` · `react-dom/client` | preact/compat on esm.sh — `triple-sdk/react`'s hooks run unchanged |
| `preact` · `preact/hooks` · `htm/preact` | esm.sh |

plus Tailwind from its CDN, `<div id="root">`, and `<script type="module"
src="./app.js">`. The two `/platform/*` bundles are static assets built once at
deploy (`pnpm --filter worker platform:build`), not per-workspace data.

From inside an app, on either channel:

```js
const apiBase = location.pathname.replace(/\/apps\/.*$/, "/api");   // this workspace's /api
const me = await (await fetch("/api/me")).json();                    // { actor, name } — auth is ambient
const client = new TripleClient({ schema, transport: new HttpTransport(apiBase) });
```

Apps are pure clients: they hit the same `/api` as everything else, as the
signed-in viewer, under the same policy.

## The MCP protocol

Stateless [streamable HTTP](https://modelcontextprotocol.io): every message is
one `POST` to the workspace's `/mcp` with a JSON-RPC 2.0 body; there is no
session and nothing to keep open, which is what lets it ride the Durable
Object request model like any API call. Identity comes from the connection,
exactly as for `/api` — the edge verifies the member and rewrites the actor
headers before the cell sees the request.

```
POST /w/<workspace>/mcp
content-type: application/json
accept: application/json, text/event-stream
```

| method | result |
|---|---|
| `initialize` | `{ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo }` |
| `notifications/initialized` | `202`, no body |
| `ping` | `{}` |
| `tools/list` | the eight tools below with their JSON-schema inputs |
| `tools/call` `{ name, arguments }` | `{ content: [{ type: "text", text }] }`, plus `isError: true` on failure — the text is the reason (a policy rejection reads as the policy's own message) |

Every tool runs **as the member** who called it.

| tool | arguments | returns |
|---|---|---|
| `get_schema` | — | the workspace's entities and fields, its access rules in prose, and how to build, serve and publish. **Read this first.** |
| `list_apps` | — | `[{ name, live: version \| null }]` |
| `list_files` | `app` | the draft file paths |
| `read_file` | `app`, `path` | the draft's content |
| `write_file` | `app`, `path`, `content` | `{ draft: "…/apps/<app>/draft/", note }` — creates the app on first write; live is unchanged |
| `delete_file` | `app`, `path` | `{ deleted: boolean }` |
| `publish` | `app` | `{ version, url: "…/apps/<app>/" }` |
| `query` | `entity`, `where?`, `select?` | permission-filtered rows — the same rows an app would see |

`query` speaks the schema's vocabulary, not the wire format: `where` is
`field → value` (an array means any-of; ref fields accept a bare id string),
`select` is a list of field names (default: all). At least one `where` is
required — the engine has no whole-entity scan. Names: `app` and `path` are
validated (`[A-Za-z0-9_-]+`, simple relative paths, no `..`, not under
`draft/`).

A session, end to end:

```jsonc
→ { "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "agent", "version": "1" } } }
← { "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "2025-06-18", "capabilities": { "tools": {} },
    "serverInfo": { "name": "workspace-platform", "version": "0.2.0" } } }

→ { "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "get_schema", "arguments": {} } }
← … "Workspace schema (generation de8cfa66): user: name, email? · todo: text, completed, shared, owner, … · app: name, live? · …"

→ { "jsonrpc": "2.0", "id": 3, "method": "tools/call",
    "params": { "name": "write_file", "arguments": { "app": "hello", "path": "app.js", "content": "import { html, render } from 'htm/preact'; …" } } }
← { "content": [{ "type": "text", "text": "{ \"draft\": \"/w/org_dev/apps/hello/draft/\", \"note\": \"live URL unchanged until you publish\" }" }] }

→ { "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "publish", "arguments": { "app": "hello" } } }
← { "content": [{ "type": "text", "text": "{ \"version\": 1, \"url\": \"/w/org_dev/apps/hello/\" }" }] }

→ { "jsonrpc": "2.0", "id": 5, "method": "tools/call",
    "params": { "name": "query", "arguments": { "entity": "release", "where": { "version": 1 }, "select": ["publishedBy", "schemaGeneration"] } } }
← [ { "id": "release_9e4a5c2b", "publishedBy": { "id": "user_alice" }, "schemaGeneration": "de8cfa66" } ]
```

## Wiring it into a cell

```ts
// the shared shape — spread the platform's entities into the workspace schema
import { platformEntities } from "workspace-platform/schema";
export const platform = platformEntities(User);
export const schema = Schema.build({ user: User, todo: Todo, ...platform });

// the server — spread the platform's rules into the policy
import { platformPolicies } from "workspace-platform/policy";
export const policy = Policy.build(schema, { user: userPolicy, todo: todoPolicy, ...platformPolicies(platform) });

// the cell — three doors, one TripleServer
import { createPlatform, handleMcp, serveApp } from "workspace-platform";
const platform = createPlatform({ server, schema });
if (path === "/mcp")             return handleMcp(request, { platform, actor, appBase: "/w/<ws>/apps", accessRules });
if (path.startsWith("/apps/"))   return serveApp(platform, actor, path.slice("/apps".length));
```

`accessRules` is the workspace's policy in prose, handed to `get_schema` —
policies are lambdas and cannot describe themselves. The edge gates `/mcp` and
`/apps/*` exactly as it gates `/api`: identify, check membership, strip and
rewrite the actor headers, forward to the workspace's cell.

## Trade-offs and known gaps

- **Every connected member receives file contents on every save.** Fan-out is
  filtered by permission, not interest, and drafts are readable by every
  member — so an agent saving a 50KB `app.js` sends 50KB to every open client
  in the workspace. Fine at team scale; the designed fix is the client handing
  the cell its predicate set as a coarse pre-filter (SDK README, §11).
- **All apps in a workspace share one origin.** App A can read app B's
  `localStorage`, and both run under the same ambient cookie auth. The trust
  model today is "an app is as trusted as the members who can see it"; the
  real fix is per-app subdomains, and it is the unglamorous hard part of
  letting agents deploy code your colleagues run.
- **No per-app owner or audience yet.** Any member can publish any app or
  flip its files. The rules are one file (`policy.ts`); an `audience` field
  and a `createdBy` ref are the obvious next step.
- **Limits.** A Durable Object row is capped at 2 MB, and a publish is one log
  row containing every file's content — so one publish must stay under ~2 MB.
  If that ever bites, create the `ReleaseFile`s across several transactions and
  move `App.live` last; publish stays atomic by the pointer.
- **No transforms.** Drafts are served verbatim (agents `read_file` them back);
  releases are the place a minifier or a TypeScript transpile would hook in.
- **Serving reads the whole file set** of a release or draft to serve one
  file. Files are few and small; a `where("path", …)` refinement is a
  one-line change when it matters.

## Try it

```bash
pnpm app:build && pnpm --filter worker platform:build
pnpm service:dev                     # DEV_AUTH=1 in packages/worker/.dev.vars — no WorkOS needed
pnpm --filter worker seed            # a couple of todos in org_dev, as Alice
pnpm service:smoke                   # 10 steps, the last three are this package's
```

Then point any MCP client at `http://localhost:8787/w/org_dev/mcp` — for
Claude Code: `claude mcp add --transport http workspace http://localhost:8787/w/org_dev/mcp`
— ask it to build something against the todo schema, and open the URL
`publish` returns. Without headers, a plain browser is `user_dev`.
