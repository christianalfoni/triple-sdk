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
  WORKOS_API_KEY?: string;
};

export type Identity = { actor: string; name: string; email?: string };

/** An actor's standing in ONE workspace: organization roles, or `appUser` for a signed-in non-member. */
export type Role = "admin" | "member" | "appUser";

const WORKOS = "https://api.workos.com";

// ---------------------------------------------------------------------------
// Per-request verification
// ---------------------------------------------------------------------------

export async function identify(request: Request, env: Env): Promise<Identity | null> {
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

/** The organizations this user belongs to, with their role in each — WorkOS is the workspace directory. */
export async function memberships(
  identity: Identity,
  env: Env,
): Promise<{ id: string; name: string; role: "admin" | "member" }[]> {
  if (env.DEV_AUTH === "1") {
    return [{ id: "org_dev", name: "Dev Workspace", role: "member" }];
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
    const claimed = request.headers.get("x-actor-role");
    return claimed === "admin" || claimed === "appUser" ? claimed : "member";
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

export function loginRedirect(request: Request, env: Env): Response {
  if (env.DEV_AUTH === "1") return Response.redirect(new URL("/", request.url).toString(), 302);
  const redirectUri = new URL("/auth/callback", request.url).toString();
  const url =
    `${WORKOS}/user_management/authorize?client_id=${env.WORKOS_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&provider=authkit`;
  return Response.redirect(url, 302);
}

export async function loginCallback(request: Request, env: Env): Promise<Response> {
  const code = new URL(request.url).searchParams.get("code");
  if (!code) return new Response("missing code", { status: 400 });
  const body = new URLSearchParams({
    client_id: env.WORKOS_CLIENT_ID ?? "",
    client_secret: env.WORKOS_API_KEY ?? "",
    grant_type: "authorization_code",
    code,
  });
  const response = await fetch(`${WORKOS}/user_management/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) return new Response("authentication failed", { status: 401 });
  const result = (await response.json()) as {
    access_token: string;
    user: { id: string; first_name?: string; last_name?: string; email?: string };
  };
  const name =
    [result.user.first_name, result.user.last_name].filter(Boolean).join(" ") ||
    result.user.email || result.user.id;
  const profile = await sealProfile({ name, email: result.user.email }, env);
  const headers = new Headers({ location: "/" });
  const attrs = "HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=28800";
  headers.append("set-cookie", `session=${result.access_token}; ${attrs}`);
  headers.append("set-cookie", `profile=${profile}; ${attrs}`);
  return new Response(null, { status: 302, headers });
}

export function logout(request: Request): Response {
  const headers = new Headers({ location: "/" });
  for (const name of ["session", "profile"]) {
    headers.append("set-cookie", `${name}=; HttpOnly; Secure; Path=/; Max-Age=0`);
  }
  void request;
  return new Response(null, { status: 302, headers });
}

// ---------------------------------------------------------------------------
// WebCrypto plumbing — RS256 JWKS verify + HMAC-sealed profile
// ---------------------------------------------------------------------------

let jwks: { keys: JsonWebKey[]; at: number } | undefined;

async function verifyJwt(token: string, clientId: string): Promise<Record<string, unknown> | null> {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  if (!jwks || jwks.at < Date.now() - 3_600_000) {
    const response = await fetch(`${WORKOS}/sso/jwks/${clientId}`);
    if (!response.ok) return null;
    jwks = { keys: ((await response.json()) as { keys: JsonWebKey[] }).keys, at: Date.now() };
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

async function sealProfile(profile: { name: string; email?: string }, env: Env): Promise<string> {
  const body = btoa(JSON.stringify(profile));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(mac))}`;
}

async function openProfile(
  sealed: string | undefined, env: Env,
): Promise<{ name: string; email?: string } | null> {
  if (!sealed) return null;
  const [body, mac] = sealed.split(".");
  if (!body || !mac) return null;
  const ok = await crypto.subtle.verify(
    "HMAC", await hmacKey(env), b64url(mac), new TextEncoder().encode(body),
  );
  return ok ? (JSON.parse(atob(body)) as { name: string; email?: string }) : null;
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
