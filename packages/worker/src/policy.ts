// SERVER ONLY (§10.1) — the worker imports the shape; the shape never imports this.
//
// The trust split, stated once: the EDGE decides workspace-level access (are you
// a member of this org at all — WorkOS says); these rules decide row-level
// access within. `shared` is in the declared fields, so flipping it is a
// visibility change the engine can see — unsharing arrives at other members as
// a live removal (§10.6), and at offline members via repair on reconnect.
import { Policy } from "triple-sdk/server/policy";
import { platformPolicies } from "workspace-platform/policy";
import { platform, schema, Todo, User } from "app-schema";

/**
 * The rules below, in prose, for the MCP `get_schema` tool — policies are
 * lambdas and cannot describe themselves, so this is kept next to them.
 */
export const accessRules = [
  "Todos are PRIVATE to their owner unless shared=true (then every member sees them);",
  "only the owner writes, except `completed`, which anyone who can see the todo may toggle.",
  "Creating a todo: set owner to the viewer — tx.create(Todo, { …, owner: { id: me.actor } }).",
  "Users: everyone reads, only you write yours.",
].join("\n");

export const userPolicy = Policy.from(User, {
  read: () => true, // names are visible to fellow members (the edge gated entry)
  create: (ctx) => ctx.subject === ctx.actor,
  update: (ctx) => ctx.subject === ctx.actor,
  delete: (ctx) => ctx.subject === ctx.actor,
});

export const todoPolicy = Policy.from(Todo, {
  fields: { owner: true, shared: true },
  // Yours, or on the board.
  read: (ctx) => ctx.fields.owner?.id === ctx.actor || ctx.fields.shared === true,
  create: (ctx) => ctx.fields.owner?.id === ctx.actor,
  update: (ctx) => ctx.fields.owner?.id === ctx.actor,
  delete: (ctx) => ctx.fields.owner?.id === ctx.actor,
  overrides: {
    // The collaborative exception: anyone who can SEE a shared todo may tick it.
    completed: {
      write: (ctx) => ctx.fields.owner?.id === ctx.actor || ctx.fields.shared === true,
    },
  },
});

export const policy = Policy.build(schema, {
  user: userPolicy,
  todo: todoPolicy,
  ...platformPolicies(platform),
});
