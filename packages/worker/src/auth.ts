/**
 * Authentication at the EDGE — WorkOS AuthKit, spoken directly (two REST calls
 * and a WebCrypto JWKS verify, ~zero dependencies), plus the DEV_AUTH bypass so
 * local development and the service smoke never need keys.
 *
 * Session shape: two HttpOnly cookies. `session` holds the WorkOS access token
 * (a JWT we verify per request against the AuthKit JWKS); `profile` holds
 * name/email, HMAC-signed so it cannot be forged client-side.
 */

export type Env = {
  DEV_AUTH?: string;
  WORKOS_CLIENT_ID?: string;
  /** The environment's secret key (sk_…): the bearer for every API call, and the cookie/token HMAC key. */
  WORKOS_API_KEY?: string;
  /** Only when the dashboard gives the application its OWN client secret; otherwise the API key is the secret. */
  WORKOS_CLIENT_SECRET?: string;
  /**
   * The AuthKit domain (https://….authkit.app): the OAuth authorization server
   * for MCP clients such as claude.ai. Its tokens name this service's `/mcp`
   * as their audience (a Resource Indicator registered in the dashboard).
   */
  WORKOS_AUTHKIT_DOMAIN?: string;
};

export type Identity = {
  actor: string;
  name: string;
  email?: string;
  /** Set when the identity came from a workspace token: the ONE workspace it may address. */
  org?: string;
};

/** An actor's standing in ONE workspace: organization roles, or `appUser` for a signed-in non-member. */
export type Role = "admin" | "member" | "appUser";

const WORKOS = "https://api.workos.com";

// ---------------------------------------------------------------------------
// Per-request verification
// ---------------------------------------------------------------------------

export async function identify(request: Request, env: Env): Promise<Identity | null> {
  // No browser cookie: a bearer. Either a workspace token the console minted
  // (`wt_…`, one workspace), or an OAuth access token AuthKit issued to an MCP
  // client — the MCP spec's own flow, which is how claude.ai connects.
  const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (bearer) return bearer.startsWith("wt_") ? openToken(bearer, env) : identifyOAuth(bearer, request, env);
  if (env.DEV_AUTH === "1") {
    // Dev: headers stand in for WorkOS. `x-actor: anonymous` simulates "not signed in".
    const actor = request.headers.get("x-actor") ?? "user_dev";
    if (actor === "anonymous") return null;
    const email = request.headers.get("x-actor-email");
    return {
      actor,
      name: request.headers.get("x-actor-name") ?? actor.replace(/^user_/, ""),
      ...(email ? { email } : {}),
    };
  }
  const cookies = parseCookies(request.headers.get("cookie") ?? "");
  const token = cookies["session"];
  if (!token || !env.WORKOS_CLIENT_ID) return null;
  const claims = await verifyJwt(token, env.WORKOS_CLIENT_ID);
  if (!claims) return null;
  const profile = await openProfile(cookies["profile"], env);
  return {
    actor: String(claims.sub),
    name: profile?.name ?? String(claims.sub),
    ...(profile?.email ? { email: profile.email } : {}),
  };
}

/** The OAuth resource this service is, for MCP clients: its own `/mcp`. */
export function mcpResource(request: Request): string {
  return new URL("/mcp", request.url).toString();
}

/**
 * An AuthKit access token, verified the way the MCP spec's resource server
 * verifies: signature against the AuthKit JWKS, issuer = the AuthKit domain,
 * audience = this service's `/mcp`. The token names the user (`sub`); their
 * profile comes from the API, cached briefly.
 */
async function identifyOAuth(token: string, request: Request, env: Env): Promise<Identity | null> {
  const issuer = env.WORKOS_AUTHKIT_DOMAIN?.replace(/\/$/, "");
  if (!issuer) return null;
  const claims = await verifyJwtAt(`${issuer}/oauth2/jwks`, token);
  if (!claims || claims.iss !== issuer) return null;
  const audience = claims.aud;
  const resource = mcpResource(request);
  if (!(audience === resource || (Array.isArray(audience) && audience.includes(resource)))) return null;
  const user = await profileOf(String(claims.sub), env);
  return { actor: String(claims.sub), name: user.name, ...(user.email ? { email: user.email } : {}) };
}

const profileCache = new Map<string, { at: number; profile: { name: string; email?: string } }>();
async function profileOf(userId: string, env: Env): Promise<{ name: string; email?: string }> {
  const cached = profileCache.get(userId);
  if (cached && cached.at > Date.now() - 300_000) return cached.profile;
  const user = (await workos(env, `/user_management/users/${userId}`)) as {
    first_name?: string; last_name?: string; email?: string;
  };
  const profile = {
    name: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email || userId,
    ...(user.email ? { email: user.email } : {}),
  };
  profileCache.set(userId, { at: Date.now(), profile });
  return profile;
}

/** Dev only: workspaces created this session, so the console can list them without WorkOS. */
const devWorkspaces = new Map<string, { id: string; name: string }>();

/**
 * Create a workspace: a WorkOS organization, with the creator as its first
 * admin. The cell needs no creation step — `idFromName(org)` materializes it
 * on first request.
 */
export async function createWorkspace(
  identity: Identity,
  name: string,
  env: Env,
): Promise<{ id: string; name: string; role: "admin" }> {
  if (env.DEV_AUTH === "1") {
    const id = `org_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace"}`;
    devWorkspaces.set(id, { id, name });
    return { id, name, role: "admin" };
  }
  const organization = (await workosPost(env, "/organizations", { name })) as { id: string; name: string };
  await workosPost(env, "/user_management/organization_memberships", {
    user_id: identity.actor,
    organization_id: organization.id,
    role_slug: "admin",
  });
  membershipCache.delete(identity.actor);
  return { id: organization.id, name: organization.name, role: "admin" };
}

/** The organizations this user belongs to, with their role in each — WorkOS is the workspace directory. */
export async function memberships(
  identity: Identity,
  env: Env,
): Promise<{ id: string; name: string; role: "admin" | "member" }[]> {
  if (env.DEV_AUTH === "1") {
    return [
      { id: "org_dev", name: "Dev Workspace", role: "admin" },
      ...[...devWorkspaces.values()].map((workspace) => ({ ...workspace, role: "admin" as const })),
    ];
  }
  const response = await workos(
    env,
    `/user_management/organization_memberships?user_id=${identity.actor}&statuses=active`,
  );
  const list = (
    response as { data: { organization_id: string; organization_name?: string; role?: { slug?: string } }[] }
  ).data;
  const out: { id: string; name: string; role: "admin" | "member" }[] = [];
  for (const entry of list) {
    out.push({
      id: entry.organization_id,
      name:
        entry.organization_name ??
        ((await workos(env, `/organizations/${entry.organization_id}`)) as { name: string }).name,
      role: entry.role?.slug === "admin" ? "admin" : "member",
    });
  }
  return out;
}

/**
 * The actor's standing in this workspace. Members carry their organization
 * role; anyone else signed in is an `appUser` — the cell's policy decides what an
 * app user may open and see. Dev: `x-actor-role` (admin | member | appUser),
 * default member.
 */
export async function roleIn(request: Request, identity: Identity, org: string, env: Env): Promise<Role> {
  if (env.DEV_AUTH === "1") {
    // Dev: whoever you claim to be is an admin unless you say otherwise — you
    // are playing with your own workspace.
    const claimed = request.headers.get("x-actor-role");
    return claimed === "member" || claimed === "appUser" ? claimed : "admin";
  }
  const cached = membershipCache.get(identity.actor);
  const roles =
    cached && cached.at > Date.now() - 60_000
      ? cached.roles
      : new Map((await memberships(identity, env)).map((m) => [m.id, m.role]));
  membershipCache.set(identity.actor, { roles, at: Date.now() });
  return roles.get(org) ?? "appUser";
}

const membershipCache = new Map<string, { roles: Map<string, "admin" | "member">; at: number }>();

/**
 * Invite someone into a workspace as a member — a WorkOS organization
 * invitation (they get the email; acceptance creates the membership the edge
 * gates on). Dev: recorded in the log line only, no email leaves.
 */
export async function inviteMember(
  env: Env,
  org: string,
  email: string,
  role: "admin" | "member",
): Promise<string> {
  if (env.DEV_AUTH === "1") {
    return `dev: ${email} would be invited to ${org} as ${role} (no email sent without WorkOS keys)`;
  }
  const response = await fetch(`${WORKOS}/user_management/invitations`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.WORKOS_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ email, organization_id: org, role_slug: role }),
  });
  if (!response.ok) throw new Error(`WorkOS invitation failed: ${response.status}`);
  return `invited ${email} to the workspace as ${role} — they will get an email`;
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

/** Where to land after sign-in: a same-site path, or `/`. Never an absolute URL. */
function returnTo(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

export function loginRedirect(request: Request, env: Env): Response {
  const back = returnTo(new URL(request.url).searchParams.get("return_to"));
  if (env.DEV_AUTH === "1") return Response.redirect(new URL(back, request.url).toString(), 302);
  const redirectUri = new URL("/auth/callback", request.url).toString();
  const url =
    `${WORKOS}/user_management/authorize?client_id=${env.WORKOS_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&provider=authkit` +
    `&state=${encodeURIComponent(back)}`;
  return Response.redirect(url, 302);
}

export async function loginCallback(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const back = returnTo(params.get("state"));
  if (!code) return new Response("missing code", { status: 400 });
  const response = await fetch(`${WORKOS}/user_management/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.WORKOS_CLIENT_ID ?? "",
      client_secret: env.WORKOS_CLIENT_SECRET ?? env.WORKOS_API_KEY ?? "",
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!response.ok) {
    // The reason goes to the worker log, never to the browser: it names the
    // WorkOS error code (invalid_client, invalid_grant, …), not a secret.
    console.error(`WorkOS authenticate: ${response.status} ${await response.text()}`);
    return new Response("authentication failed — see the worker log", { status: 401 });
  }
  const result = (await response.json()) as {
    access_token: string;
    user: { id: string; first_name?: string; last_name?: string; email?: string };
  };
  const name =
    [result.user.first_name, result.user.last_name].filter(Boolean).join(" ") ||
    result.user.email || result.user.id;
  const profile = await sealProfile({ name, email: result.user.email }, env);
  const headers = new Headers({ location: back });
  const attrs = `HttpOnly; ${secureAttr(request)}Path=/; SameSite=Lax; Max-Age=28800`;
  headers.append("set-cookie", `session=${result.access_token}; ${attrs}`);
  headers.append("set-cookie", `profile=${profile}; ${attrs}`);
  return new Response(null, { status: 302, headers });
}

export function logout(request: Request): Response {
  const headers = new Headers({ location: "/" });
  for (const name of ["session", "profile"]) {
    headers.append("set-cookie", `${name}=; HttpOnly; ${secureAttr(request)}Path=/; Max-Age=0`);
  }
  return new Response(null, { status: 302, headers });
}

/** `Secure` on https only: browsers (Safari) refuse Secure cookies over http://localhost. */
function secureAttr(request: Request): string {
  return new URL(request.url).protocol === "https:" ? "Secure; " : "";
}

// ---------------------------------------------------------------------------
// WebCrypto plumbing — RS256 JWKS verify + HMAC-sealed profile
// ---------------------------------------------------------------------------

/** Session tokens (the cookie) verify against the application's SSO JWKS. */
function verifyJwt(token: string, clientId: string): Promise<Record<string, unknown> | null> {
  return verifyJwtAt(`${WORKOS}/sso/jwks/${clientId}`, token);
}

const jwksCache = new Map<string, { keys: JsonWebKey[]; at: number }>();

async function verifyJwtAt(jwksUrl: string, token: string): Promise<Record<string, unknown> | null> {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  let jwks = jwksCache.get(jwksUrl);
  if (!jwks || jwks.at < Date.now() - 3_600_000) {
    const response = await fetch(jwksUrl);
    if (!response.ok) return null;
    jwks = { keys: ((await response.json()) as { keys: JsonWebKey[] }).keys, at: Date.now() };
    jwksCache.set(jwksUrl, jwks);
  }
  const data = new TextEncoder().encode(`${h}.${p}`);
  const signature = b64url(sig);
  for (const key of jwks.keys) {
    try {
      const cryptoKey = await crypto.subtle.importKey(
        "jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
      );
      if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, data)) {
        const claims = JSON.parse(new TextDecoder().decode(b64url(p))) as Record<string, unknown>;
        if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return null;
        return claims;
      }
    } catch {
      // try the next key
    }
  }
  return null;
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.WORKOS_API_KEY ?? "dev"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

/** Seal a JSON value under a purpose-tagged HMAC (a profile can never pass as a token). UTF-8 safe. */
async function seal(purpose: string, value: unknown, env: Env): Promise<string> {
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(`${purpose}:${body}`));
  return `${body}.${b64urlEncode(new Uint8Array(mac))}`;
}

async function open<T>(purpose: string, sealed: string | undefined, env: Env): Promise<T | null> {
  if (!sealed) return null;
  const [body, mac] = sealed.split(".");
  if (!body || !mac) return null;
  const ok = await crypto.subtle.verify(
    "HMAC", await hmacKey(env), b64url(mac), new TextEncoder().encode(`${purpose}:${body}`),
  );
  return ok ? (JSON.parse(new TextDecoder().decode(b64url(body))) as T) : null;
}

const sealProfile = (profile: { name: string; email?: string }, env: Env) => seal("profile", profile, env);
const openProfile = (sealed: string | undefined, env: Env) =>
  open<{ name: string; email?: string }>("profile", sealed, env);

/**
 * A workspace token: a signed-in member's identity, scoped to ONE workspace,
 * for clients that have no browser — an agent's MCP client. Thirty days.
 */
export async function mintToken(identity: Identity, org: string, env: Env): Promise<{ token: string; expires: number }> {
  const expires = Date.now() + 30 * 86_400_000;
  const token = await seal(
    "token",
    { actor: identity.actor, name: identity.name, email: identity.email, org, expires },
    env,
  );
  return { token: `wt_${token}`, expires };
}

async function openToken(token: string, env: Env): Promise<Identity | null> {
  if (!token.startsWith("wt_")) return null;
  const claims = await open<{ actor: string; name: string; email?: string; org: string; expires: number }>(
    "token", token.slice(3), env,
  );
  if (!claims || claims.expires < Date.now()) return null;
  return { actor: claims.actor, name: claims.name, ...(claims.email ? { email: claims.email } : {}), org: claims.org };
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function b64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function workos(env: Env, path: string): Promise<unknown> {
  const response = await fetch(`${WORKOS}${path}`, {
    headers: { authorization: `Bearer ${env.WORKOS_API_KEY}` },
  });
  if (!response.ok) throw new Error(`WorkOS ${path}: ${response.status}`);
  return response.json();
}

async function workosPost(env: Env, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${WORKOS}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.WORKOS_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`WorkOS POST ${path}: ${response.status}`);
  return response.json();
}
