/**
 * `import { auth } from "auth"` — what an app needs to know about who is
 * looking at it. Served to the browser as /platform/auth.js; no dependencies.
 *
 * Auth is AMBIENT: the session is a cookie the edge set at sign-in, so there is
 * nothing to store or attach. This module only asks the workspace who the
 * cookie belongs to, and knows the two URLs that change it.
 */

/** This workspace's /api, derived from the app's own URL (draft or live). */
export const apiBase = location.pathname.replace(/\/apps\/.*$/, "/api");

export type Me = {
  actor: string;
  name: string;
  email?: string;
  /** admin · member · appUser — the caller's standing in THIS workspace. */
  role: "admin" | "member" | "appUser";
};

export const auth = {
  apiBase,

  /** Who is signed in, in this workspace — or null when nobody is. */
  async me(): Promise<Me | null> {
    const response = await fetch(`${apiBase}/me`);
    return response.ok ? ((await response.json()) as Me) : null;
  },

  /** Go sign in (AuthKit: Google, Microsoft, passkeys, …) and come back here. */
  login(returnTo: string = location.pathname + location.search): void {
    location.href = `/auth/login?return_to=${encodeURIComponent(returnTo)}`;
  },

  logout(): void {
    location.href = "/auth/logout";
  },
};
