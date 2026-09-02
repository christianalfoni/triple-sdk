/**
 * Type-level tests for SPEC §10 — `npm run typecheck` IS the assertion.
 *
 * Policies are standalone (`Policy.from(Entity, …)`) under a vocabulary bound
 * ONCE to the actor entity (`definePolicy({ actor: User })`); coverage is
 * checked where the pieces assemble: `Policy.build(schema, { … })` requires one
 * key per entity, so a missing policy is a missing property, named. If
 * inference ever regresses to `any`, the @ts-expect-error lines stop erroring
 * and the build fails.
 */

import { definePolicy } from "./policy.ts";
import { Schema } from "../shared/schema.ts";

const User = Schema.from({
  name: Schema.string(),
  role: Schema.oneOf("admin", "member", "appUser"),
});
const Team = Schema.from({
  name: Schema.string(),
  member: Schema.ref(User).multiple(),
});
const Todo = Schema.from({
  text: Schema.string(),
  owner: Schema.ref(User),
  team: Schema.ref(Team),
});
const schema = Schema.build({ user: User, team: Team, todo: Todo });

const Policy = definePolicy({ actor: User });

// The SDK ships NO checks — a check is any `(ctx) => boolean`. This hand-rolled
// reusable one pins that user-defined helpers compose with fields inference.
const anyone = (): boolean => true;
const owns =
  <K extends string>(field: K) =>
  (ctx: { actor: { id: string }; fields: { [P in K]: { id: string } | undefined } }): boolean =>
    ctx.fields[field]?.id === ctx.actor.id;

const open = { read: anyone, create: anyone, update: anyone, delete: anyone };
const user = Policy.from(User, open);
const team = Policy.from(Team, open);

/** Inline checks infer their ctx from the declared fields — at depth 2, no
 * casts, and `undefined` from an optional chain is a legal (denying) verdict.
 * `ctx.actor` carries the actor entity's fields: `role` is the oneOf literal. */
export const todo = Policy.from(Todo, {
  fields: { owner: true, team: { member: true } },
  read: (ctx) =>
    ctx.fields.owner?.id === ctx.actor.id ||
    ctx.fields.team?.member.some((m) => m.id === ctx.actor.id) ||
    ctx.actor.role === "admin",
  create: (ctx) => ctx.fields.owner?.id === ctx.actor.id, // fields = the landing state
  update: owns("owner"),
  delete: owns("owner"),
});

export const unknownRole = Policy.from(Todo, {
  // @ts-expect-error — "owner" is not one of the oneOf values
  read: (ctx) => ctx.actor.role === "owner",
  create: anyone,
  update: anyone,
  delete: anyone,
});

export const unknownActorField = Policy.from(Todo, {
  // @ts-expect-error — User has no `team` field, so neither does the actor record
  read: (ctx) => ctx.actor.team !== undefined,
  create: anyone,
  update: anyone,
  delete: anyone,
});

export const insufficient = Policy.from(Todo, {
  fields: { owner: true },
  // @ts-expect-error — reads `team`, which the declared fields do not include
  read: (ctx) => ctx.fields.team !== undefined,
  create: anyone,
  update: anyone,
  delete: anyone,
});

export const helperStarved = Policy.from(Todo, {
  fields: { text: true },
  read: anyone,
  create: anyone,
  // @ts-expect-error — owns("owner") demands `owner` among the declared fields
  update: owns("owner"),
  delete: anyone,
});

// @ts-expect-error — a rule must define every verb: `delete` is missing
export const missingVerb = Policy.from(Todo, {
  read: anyone,
  create: anyone,
  update: anyone,
});

export const noAfterOnCreate = Policy.from(Todo, {
  fields: { owner: true },
  read: anyone,
  // @ts-expect-error — create has no `after`: its `fields` IS the landing state
  create: (ctx) => ctx.after.owner?.id === ctx.actor.id,
  update: (ctx) => ctx.after.owner?.id === ctx.actor.id, // update HAS both states
  delete: anyone,
});

/** Full coverage builds. */
export const complete = Policy.build(schema, { user, team, todo });

// @ts-expect-error — "todo" has no policy: a plain missing-property error names it
export const incomplete = Policy.build(schema, { user, team });

// @ts-expect-error — todoPolicy under the "user" key: the pairing is checked too
export const misplaced = Policy.build(schema, { user: todo, team, todo: user });
