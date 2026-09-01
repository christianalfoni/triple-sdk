// SERVER ONLY (§10.1) — the worker imports the shape; the shape never imports this.
//
// The trust split, stated once: the EDGE decides workspace-level access (are you
// a member of this org at all — WorkOS says); these rules decide row-level
// access within. `shared` is in the declared fields, so flipping it is a
// visibility change the engine can see — unsharing arrives at other members as
// a live removal (§10.6), and at offline members via repair on reconnect.
import { Policy } from "triple-sdk/server/policy";
import { schema, Todo, User } from "app-schema";

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

export const policy = Policy.build(schema, { user: userPolicy, todo: todoPolicy });
