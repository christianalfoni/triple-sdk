// SERVER ONLY — clients never see rules and never need them: everything they
// receive is already filtered, inside the scan (never on results — that leaks
// through counts and joins).
//
// One standalone policy per entity; Policy.build checks coverage — omit one
// entity and it does not compile. A check is just `(ctx) => boolean | undefined`,
// written inline: ONE way to write rules, with the language's full reach. (The
// declarative-expression alternative was built, measured and deliberately
// removed — SPEC §10.7 records that fork and what it would buy back.) Why
// `fields` is DECLARED data instead of reads inside the checks: the engine
// loads it once per subject (not per triple), shares it across all actors in a
// fan-out, and knows statically which writes change whose visibility — a
// revocation touching a 500-todo team reaches 500 subscribers in ~22ms.
import { Policy } from "../../sdk/server/policy.ts";
import { schema, Team, Todo, User } from "../shared/schema.ts";

// Names are public; only you may touch your own entity (the subject IS you).
export const userPolicy = Policy.from(User, {
  read: () => true,
  create: (ctx) => ctx.subject === ctx.actor,
  update: (ctx) => ctx.subject === ctx.actor,
  delete: (ctx) => ctx.subject === ctx.actor,
});

export const teamPolicy = Policy.from(Team, {
  fields: { member: true },
  read: (ctx) => ctx.fields.member.some((m) => m.id === ctx.actor),
  create: () => false, // teams are made by the server (seed) for now
  update: (ctx) => ctx.fields.member.some((m) => m.id === ctx.actor),
  delete: () => false,
});

export const todoPolicy = Policy.from(Todo, {
  fields: {
    owner: true, // depth 1 — field comparison
    team: { member: true }, // depth 2 — traversal along the ref
  },
  // Read: yours, or your team's. `ctx.fields` is typed from the declaration
  // above — reaching for anything it does not declare is a compile error. A rule
  // may return undefined (`team?.` hit nothing): only an explicit true GRANTS.
  read: (ctx) =>
    ctx.fields.owner?.id === ctx.actor ||
    ctx.fields.team?.member.some((m) => m.id === ctx.actor),
  // Same shape for all three verbs — but each sees a different state: a create
  // has no pre-state, so its `fields` IS the todo once it lands (must name you);
  // update/delete see the current fields (it must have been yours).
  create: (ctx) => ctx.fields.owner?.id === ctx.actor,
  update: (ctx) => ctx.fields.owner?.id === ctx.actor,
  delete: (ctx) => ctx.fields.owner?.id === ctx.actor,
  // §10.4 — a field-sized exception: team members may toggle `completed` on a
  // team todo. The override REPLACES the entity rule for THIS field's changes;
  // text, owner and delete stay owner-only (the rules above).
  overrides: {
    completed: {
      write: (ctx) =>
        ctx.fields.owner?.id === ctx.actor ||
        ctx.fields.team?.member.some((m) => m.id === ctx.actor),
    },
  },
});

// from → build, same pairing as the schema side: one key per entity, REQUIRED —
// omit one and the compile error names the missing entity. Deny-by-default.
export const policy = Policy.build(schema, {
  user: userPolicy,
  team: teamPolicy,
  todo: todoPolicy,
});
