/**
 * SERVER ONLY — the platform's rules, in the same vocabulary as the workspace's
 * own (§10). Rules run AS a User: `ctx.actor` is the actor's own record, with
 * the `role` and `email` the platform requires of the user entity
 * (`platformUserFields`).
 *
 * Who may do what, in one place:
 *   members (admin, member)   develop: read and write every app's drafts, publish, change audiences
 *   guests (signed in, not a member)   OPEN apps whose audience admits them — nothing else
 *   anonymous (not signed in)          open PUBLIC apps — nothing else
 *
 * "May open the app" is the App's read rule; serving resolves the app through
 * the policy filter, so there is no second access-control system. Releases and
 * their files inherit it by traversing to their app — a guest who may open an
 * app may read exactly the files its live release serves.
 *
 * Immutability is POLICY, not mechanism: `Release` and `ReleaseFile` have
 * update/delete rules that never grant. Rollback is publishing again (or
 * unpublishing). A consequence: an app that has ever been published cannot be
 * deleted, because its releases reference it and required refs may not dangle
 * (§4.5) — history is permanent.
 *
 * Every rule is written POSITIVELY (`role === "member"`), never by exclusion: an
 * actor with no row yet reads `role` as undefined, and undefined must deny.
 */
import { definePolicy } from "triple-sdk/server/policy";
import type { EntityDef } from "triple-sdk/schema";
import type { PlatformEntities, PlatformUserFields } from "./schema.ts";

type Actor = { id: string; role?: string | undefined; email?: string | undefined };
type Audience = { audience?: string | undefined; invited?: readonly string[] | undefined };

export function platformPolicies<U extends EntityDef & PlatformUserFields>(
  User: U,
  entities: PlatformEntities<U>,
) {
  const Policy = definePolicy({ actor: User });
  const isMember = (actor: Actor): boolean => actor.role === "admin" || actor.role === "member";
  const mayOpen = (actor: Actor, app: Audience | undefined): boolean =>
    app !== undefined &&
    (isMember(actor) ||
      app.audience === "public" ||
      (app.audience === "invited" && actor.email !== undefined && app.invited?.includes(actor.email) === true));
  const never = () => false;

  return {
    app: Policy.from(entities.app, {
      fields: { audience: true, invited: true },
      read: (ctx) => mayOpen(ctx.actor, ctx.fields),
      create: (ctx) => isMember(ctx.actor),
      update: (ctx) => isMember(ctx.actor), // publishing repoints `live`; audiences and invites live here too
      delete: (ctx) => isMember(ctx.actor),
    }),
    draftFile: Policy.from(entities.draftFile, {
      read: (ctx) => isMember(ctx.actor), // drafts are the workbench — members only, view-source included
      create: (ctx) => isMember(ctx.actor),
      update: (ctx) => isMember(ctx.actor),
      delete: (ctx) => isMember(ctx.actor),
    }),
    release: Policy.from(entities.release, {
      fields: { app: { audience: true, invited: true } },
      read: (ctx) => mayOpen(ctx.actor, ctx.fields.app),
      create: (ctx) => isMember(ctx.actor),
      update: never,
      delete: never,
    }),
    releaseFile: Policy.from(entities.releaseFile, {
      fields: { release: { app: { audience: true, invited: true } } },
      read: (ctx) => mayOpen(ctx.actor, ctx.fields.release?.app),
      create: (ctx) => isMember(ctx.actor),
      update: never,
      delete: never,
    }),
  };
}
