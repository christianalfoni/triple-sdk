/**
 * SERVER ONLY — the platform's rules, in the same vocabulary as the workspace's
 * own (§10). Deliberately plain for v1: the edge has already proved workspace
 * membership, so every member may develop and publish every app.
 *
 * Immutability is POLICY, not mechanism: there is no frozen flag anywhere —
 * `Release` and `ReleaseFile` simply have update/delete rules that never
 * grant. Rollback is publishing again (or repointing `App.live`). A
 * consequence worth knowing: an app that has ever been published cannot be
 * deleted, because its releases reference it and required refs may not dangle
 * (§4.5) — history is permanent. Per-app ownership and audiences are the
 * obvious next step and change nothing structural: they are more rules here.
 */
import { Policy } from "triple-sdk/server/policy";
import type { EntityDef } from "triple-sdk/schema";
import type { PlatformEntities } from "./schema.ts";

export function platformPolicies<U extends EntityDef>(entities: PlatformEntities<U>) {
  const anyMember = () => true;
  const never = () => false;
  return {
    app: Policy.from(entities.app, {
      read: anyMember,
      create: anyMember,
      update: anyMember, // publishing repoints `live`
      delete: anyMember,
    }),
    draftFile: Policy.from(entities.draftFile, {
      read: anyMember, // drafts are visible — view-source is a feature
      create: anyMember,
      update: anyMember,
      delete: anyMember,
    }),
    release: Policy.from(entities.release, {
      read: anyMember,
      create: anyMember,
      update: never,
      delete: never,
    }),
    releaseFile: Policy.from(entities.releaseFile, {
      read: anyMember,
      create: anyMember,
      update: never,
      delete: never,
    }),
  };
}
