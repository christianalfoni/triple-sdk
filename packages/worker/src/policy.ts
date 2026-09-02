// SERVER ONLY (§10.1) — the worker imports the shape; the shape never imports this.
//
// The trust split, stated once: the EDGE decides who reaches the cell and AS
// WHOM (a member with a role, an app user, or anonymous — WorkOS says); these rules
// decide row-level access within. `shared` is in the declared fields, so
// flipping it is a visibility change the engine can see — unsharing arrives at
// other members as a live removal (§10.6), and at offline members via repair.
//
// Rules run AS a User: `ctx.actor` is the actor's own record — `.id`, `.role`,
// `.email` — loaded from the cell, where the edge mirrored them. Every rule is
// written POSITIVELY: an actor with no row yet has no role, and no role denies.
import { definePolicy } from "triple-sdk/server/policy";
import { platformPolicies } from "workspace-platform/policy";
import { platform, schema, Todo, User } from "app-schema";

const Policy = definePolicy({ actor: User });
const isMember = (actor: { role?: string | undefined }): boolean =>
  actor.role === "admin" || actor.role === "member";

/**
 * The rules below, in prose, for the MCP `get_schema` tool — policies are
 * lambdas and cannot describe themselves, so this is kept next to them.
 */
export const accessRules = [
  "Todos are PRIVATE to their owner unless shared=true — then every MEMBER sees them (app users never do).",
  "Only the owner writes, except `completed`, which anyone who can see the todo may toggle.",
  "Creating a todo: set owner to the viewer — tx.create(Todo, { …, owner: { id: me.actor } }). App users may own todos.",
  "Users: members read every member; an app user reads only themselves. Nobody writes another's row; `role` is never client-writable.",
].join("\n");

export const userPolicy = Policy.from(User, {
  read: (ctx) => ctx.subject === ctx.actor.id || isMember(ctx.actor),
  create: (ctx) => ctx.subject === ctx.actor.id,
  update: (ctx) => ctx.subject === ctx.actor.id,
  delete: (ctx) => ctx.subject === ctx.actor.id,
  overrides: {
    // The edge mirrors `role` from the identity provider through the cell's own
    // commit path. No client may write it — not even its owner: an app user could
    // otherwise promote themselves.
    role: { write: () => false },
  },
});

export const todoPolicy = Policy.from(Todo, {
  fields: { owner: true, shared: true },
  // Yours, or on the board — and the board is for members.
  read: (ctx) => ctx.fields.owner?.id === ctx.actor.id || (ctx.fields.shared === true && isMember(ctx.actor)),
  create: (ctx) => ctx.fields.owner?.id === ctx.actor.id,
  update: (ctx) => ctx.fields.owner?.id === ctx.actor.id,
  delete: (ctx) => ctx.fields.owner?.id === ctx.actor.id,
  overrides: {
    // The collaborative exception: anyone who can SEE a shared todo may tick it.
    completed: {
      write: (ctx) =>
        ctx.fields.owner?.id === ctx.actor.id || (ctx.fields.shared === true && isMember(ctx.actor)),
    },
  },
});

export const policy = Policy.build(schema, {
  user: userPolicy,
  todo: todoPolicy,
  ...platformPolicies(User, platform),
});
