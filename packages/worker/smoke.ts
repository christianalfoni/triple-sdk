/**
 * The SERVICE smoke: two members of one workspace, over the real worker
 * (wrangler dev, DEV_AUTH=1) — proving the product's contract end to end:
 * membership at the edge, privacy and sharing in the policy, the collaborative
 * `completed` override, and unshare arriving at the other member LIVE.
 *
 *   pnpm --filter worker dev     (terminal 1)
 *   pnpm --filter worker smoke   (terminal 2)
 */
import { HttpTransport, TripleClient } from "triple-sdk/client";
import { Query } from "triple-sdk/query";
import { App, schema, Todo, User } from "app-schema";

const base = process.env.SMOKE_URL ?? "http://localhost:8787";
const org = `org_smoke_${Math.floor(Math.random() * 1e6)}`;

/** Dev-mode identity is headers: actor, name, and the role the edge would derive from WorkOS. */
function identity(actor: string, name: string, role = "member", email?: string): Record<string, string> {
  return {
    "x-actor": actor,
    "x-actor-name": name,
    "x-actor-role": role,
    ...(email ? { "x-actor-email": email } : {}),
  };
}

function member(actor: string, name: string, role = "member", email?: string): TripleClient {
  const client = new TripleClient({
    schema,
    transport: new HttpTransport(`${base}/w/${org}/api`, identity(actor, name, role, email)),
  });
  client.connect();
  return client;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
let step = 0;
const log = (label: string, detail: string) =>
  console.log(`  ${String(++step).padStart(2)}. ${label.padEnd(18)} ${detail}`);
const fail = (message: string): never => {
  console.error(`  FAIL: ${message}`);
  process.exit(1);
};

// -- the edge gate: no identity in prod-mode would 401; DEV_AUTH forwards ours.
const me = await fetch(`${base}/api/me`, { headers: { "x-actor": "user_alice" } });
if (!me.ok) fail(`/api/me: ${me.status}`);
log("edge identity", JSON.stringify(await me.json()));

const alice = member("user_alice", "Alice", "admin");
const bob = member("user_bob", "Bob");

const boardQuery = Query.from(Todo)
  .where("shared", true)
  .select({ text: true, completed: true, owner: { name: true } });
const aliceAll = alice.watch(
  Query.from(Todo).where("owner", { id: "user_alice" }).select({ text: true, shared: true }),
);
const bobBoard = bob.watch(boardQuery);

await alice.transact((tx) => {
  tx.create(Todo, { text: "alice private", completed: false, shared: false, owner: { id: "user_alice" } });
  tx.create(Todo, { text: "alice shared", completed: false, shared: true, owner: { id: "user_alice" } });
});
await aliceAll.ready;
await bobBoard.ready;
await settle();

if (aliceAll.data.length !== 2) fail(`alice sees ${aliceAll.data.length} of her own todos`);
log("owner sees all", `alice: ${aliceAll.data.length} todos (private + shared)`);

if (bobBoard.data.length !== 1 || bobBoard.data[0]!.text !== "alice shared") {
  fail(`bob sees ${JSON.stringify(bobBoard.data.map((t) => t.text))} — privacy leak or missing share`);
}
log("privacy", `bob sees ONLY the shared todo (by ${bobBoard.data[0]!.owner.name})`);

// -- the collaborative override: bob may TICK alice's shared todo…
const sharedId = bobBoard.data[0]!.id;
const tick = await bob.transact((tx) => {
  tx.edit(Todo, sharedId).completed = true;
});
log("override", `bob ticks alice's shared todo: ${tick}`);

// -- …but may not rename it.
let renameRejected = false;
try {
  await bob.transact((tx) => {
    tx.edit(Todo, sharedId).text = "bob was here";
  });
} catch {
  renameRejected = true;
}
if (!renameRejected) fail("bob renamed alice's todo");
log("row rules", "bob's rename is rejected (owner-only)");

// -- UNSHARE: visibility revoked, arriving at bob as a live removal.
await alice.transact((tx) => {
  tx.edit(Todo, sharedId).shared = false;
});
const deadline = Date.now() + 3000;
while (bobBoard.data.length > 0 && Date.now() < deadline) await settle();
if (bobBoard.data.length !== 0) fail("unshare did not revoke live");
log("live revocation", "alice unshares → the todo VANISHES from bob's board");

// -- and alice still has it, privately.
if (aliceAll.data.length !== 2) fail("alice lost her todo on unshare");
log("still hers", `alice keeps both todos; shared flags: ${JSON.stringify(aliceAll.data.map((t) => t.shared))}`);

// -- THE PLATFORM: apps are data. An agent writes a draft over MCP, members see
//    nothing until publish, and a running app learns about a new version LIVE —
//    the registry row is just another entity under just another policy.
const mcpCall = async (
  who: Record<string, string>,
  tool: string,
  args: object,
): Promise<{ text: string; isError: boolean }> => {
  const response = await fetch(`${base}/w/${org}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...who },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const { result } = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: result.content[0]!.text, isError: result.isError === true };
};
const mcp = async (actor: string, name: string, tool: string, args: object, role = "admin"): Promise<string> => {
  const outcome = await mcpCall(identity(actor, name, role), tool, args);
  if (outcome.isError) fail(`mcp ${tool}: ${outcome.text}`);
  return outcome.text;
};
const appUrl = `${base}/w/${org}/apps/hello`;
const get = async (path: string) => {
  const response = await fetch(`${appUrl}${path}`, { headers: { "x-actor": "user_bob" } });
  return { status: response.status, body: await response.text() };
};

// bob's running app watches its own registry row — the "new version, refresh" story
const registry = bob.watch(Query.from(App).where("name", "hello").select({ live: { version: true } }));

await mcp("user_alice", "Alice", "write_file", { app: "hello", path: "app.js", content: "root.textContent = 'v1'" });
const draft = await get("/draft/app.js");
const liveBefore = await get("/");
if (draft.status !== 200 || !draft.body.includes("v1")) fail(`draft not served: ${draft.status}`);
if (liveBefore.status !== 404) fail(`live served before publish: ${liveBefore.status}`);
log("draft channel", "write_file over MCP → draft serves v1 · live is 404 until publish");

const first = JSON.parse(await mcp("user_alice", "Alice", "publish", { app: "hello" })) as { version: number };
const liveAfter = await get("/app.js");
if (first.version !== 1 || liveAfter.status !== 200 || !liveAfter.body.includes("v1")) fail("publish did not go live");
log("publish", `release ${first.version} → live serves v1 · immutable, any member may read it`);

await mcp("user_alice", "Alice", "write_file", { app: "hello", path: "app.js", content: "root.textContent = 'v2'" });
if (!(await get("/app.js")).body.includes("v1")) fail("live changed without a publish");
if (!(await get("/draft/app.js")).body.includes("v2")) fail("draft did not take the edit");
await mcp("user_alice", "Alice", "publish", { app: "hello" });
const versionDeadline = Date.now() + 3000;
while (registry.data[0]?.live?.version !== 2 && Date.now() < versionDeadline) await settle();
if (registry.data[0]?.live?.version !== 2) {
  fail(`bob's registry query did not see version 2: ${JSON.stringify(registry.data)}`);
}
log("live version", "a draft edit leaves live alone · publish 2 → bob's running query sees live.version 2");

// -- WHO IS WHO: the edge mirrors the caller's standing into their User row and
//    the cell's rules read it (`ctx.actor.role`). An app user is signed in but not a
//    member; anonymous is not signed in. Both reach the same /api, same policy.
const appUser = identity("user_appuser", "App User", "appUser", "appuser@example.com");
const anonymous = { "x-actor": "anonymous" };
// Anonymous callers are not refused, they are sent to sign in (302) — never follow it here.
const open = async (path: string, who: Record<string, string>) =>
  (await fetch(`${appUrl}${path}`, { headers: who, redirect: "manual" })).status;

if ((await open("/", appUser)) !== 404) fail("an app user opened a members-only app");
if ((await open("/", anonymous)) !== 302) fail("anonymous was not sent to sign in on a members-only app");
await mcp("user_alice", "Alice", "set_audience", { app: "hello", audience: "invited" });
await mcp("user_alice", "Alice", "invite_to_app", { app: "hello", email: "appuser@example.com" });
if ((await open("/", appUser)) !== 200) fail("an invited app user could not open the app");
if ((await open("/draft/", appUser)) !== 404) fail("an app user saw the draft");
if ((await open("/", anonymous)) !== 302) fail("anonymous was not sent to sign in on an invited app");
if ((await open("/", identity("user_bob", "Bob"))) !== 404) fail("an unlisted member opened an invited app");
if ((await open("/", identity("user_alice", "Alice", "admin"))) !== 200) fail("the admin could not open the invited app");
await mcp("user_alice", "Alice", "set_audience", { app: "hello", audience: "public" });
if ((await open("/", anonymous)) !== 200) fail("anonymous could not open a public app");
log("audiences", "members-only 404s app users · invited admits the listed app user and admins, not bob (unlisted member) · anonymous is sent to sign in · public admits anonymous · drafts stay members-only");

// -- an app user's data world is their own rows. The board is for members.
await alice.transact((tx) => {
  tx.edit(Todo, sharedId).shared = true;
});
const appUserClient = member("user_appuser", "App User", "appUser", "appuser@example.com");
const appUserTodos = appUserClient.watch(Query.from(Todo).select({ text: true }));
await appUserTodos.ready;
const boardDeadline = Date.now() + 3000;
while (bobBoard.data.length !== 1 && Date.now() < boardDeadline) await settle();
if (bobBoard.data.length !== 1) fail("bob did not see the re-shared todo");
if (appUserTodos.data.length !== 0) fail(`an app user saw ${appUserTodos.data.length} member todos`);
const promoted = await appUserClient
  .transact((tx) => {
    tx.edit(User, "user_appuser").role = "admin";
  })
  .then(() => "ALLOWED", (error: Error) => error.message);
if (promoted === "ALLOWED") fail("an app user promoted themselves");
log("app user data", `bob sees the re-shared todo, the app user sees none of it · self-promotion: "${promoted}"`);

// -- inviting INTO the workspace is the identity provider's job, and admin-only.
const refused = await mcpCall(identity("user_bob", "Bob"), "invite_member", { email: "carol@example.com" });
if (!refused.text.includes("admin")) fail(`a member invited someone: ${refused.text}`);
const invited = await mcp("user_alice", "Alice", "invite_member", { email: "carol@example.com", role: "member" });
if (!invited.includes("carol@example.com")) fail(`the admin's invite failed: ${invited}`);
log("invite member", `bob (member) is refused · alice (admin): ${invited}`);

// -- THE CONSOLE'S CONTRACT: sign-in comes back to where you were; an agent
//    carries a workspace token instead of a cookie; a workspace is one POST.
await mcp("user_alice", "Alice", "set_audience", { app: "hello", audience: "members" });
const bounced = await fetch(`${appUrl}/`, { headers: anonymous, redirect: "manual" });
const location = bounced.headers.get("location") ?? "";
if (bounced.status !== 302 || !location.includes("/auth/login?return_to=")) fail(`anonymous on a members app: ${bounced.status} ${location}`);
log("return_to", `anonymous on a members-only app → 302 ${new URL(location).pathname}?return_to=…/apps/hello/`);

const minted = (await (await fetch(`${base}/w/${org}/api/tokens`, { method: "POST", headers: identity("user_alice", "Alice") })).json()) as { token: string; mcp: string };
if (!minted.token.startsWith("wt_")) fail(`no token: ${JSON.stringify(minted)}`);
const asAgent = await mcpCall({ authorization: `Bearer ${minted.token}` }, "list_apps", {});
if (asAgent.isError || !asAgent.text.includes("hello")) fail(`token MCP call failed: ${asAgent.text}`);
const elsewhere = await fetch(`${base}/w/org_other/mcp`, { method: "POST", headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" }, body: "{}" });
if (elsewhere.status !== 403) fail(`a token crossed workspaces: ${elsewhere.status}`);
log("agent token", `POST /api/tokens → wt_… · MCP with only the bearer lists apps · the same token on another workspace: 403`);

const created = (await (await fetch(`${base}/api/workspaces`, { method: "POST", headers: { ...identity("user_alice", "Alice"), "content-type": "application/json" }, body: JSON.stringify({ name: "Smoke Co" }) })).json()) as { id: string; role: string };
const listed = (await (await fetch(`${base}/api/workspaces`, { headers: identity("user_alice", "Alice") })).json()) as { id: string }[];
if (created.role !== "admin" || !listed.some((w) => w.id === created.id)) fail(`workspace not created: ${JSON.stringify(created)}`);
const fresh = await fetch(`${base}/w/${created.id}/api/me`, { headers: identity("user_alice", "Alice", "admin") });
if (fresh.status !== 200) fail(`the new workspace's cell did not answer: ${fresh.status}`);
log("create workspace", `POST /api/workspaces → ${created.id} as admin · listed · its cell answers /api/me on first contact`);

console.log("service smoke: all green");
process.exit(0);
