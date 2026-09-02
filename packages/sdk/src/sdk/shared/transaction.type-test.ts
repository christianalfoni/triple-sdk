/**
 * Type-level tests for SPEC §9 — the draft write API. `npm run typecheck` IS
 * the assertion: required-field mistakes are COMPILE errors here, not §4.5
 * server rejections.
 */

import { Schema, type FieldBuilder } from "./schema.ts";
import { Transaction } from "./transaction.ts";
import { Store } from "./store.ts";

const User = Schema.from({ name: Schema.string() });
const Todo = Schema.from({
  text: Schema.string(),
  completed: Schema.boolean(),
  owner: Schema.ref(User),
  team: Schema.ref(User).optional(),
  tags: Schema.string().multiple(),
  position: Schema.object({ x: Schema.number(), y: Schema.number(), z: Schema.number().optional() }).optional(),
});
export const schema = Schema.build({ user: User, todo: Todo });

declare const tx: Transaction;

/** create: one typed object; requireds required, optionals optional. */
tx.create(Todo, { text: "x", completed: false, owner: { id: "user_1" } });
tx.create(Todo, { text: "x", completed: false, owner: { id: "user_1" }, tags: ["a"] });

// @ts-expect-error — `completed` is required: forgetting it does not compile
tx.create(Todo, { text: "x", owner: { id: "user_1" } });

// @ts-expect-error — wrong value type for `text`
tx.create(Todo, { text: 4, completed: false, owner: { id: "user_1" } });

/** edit: property writes, typed like the schema. */
const draft = tx.edit(Todo, "todo_1");
draft.completed = true;
draft.team = { id: "user_2" };
draft.team = undefined; // optional → clearing compiles
draft.tags.push("urgent");
draft.tags.remove("q3");
const read: boolean = draft.completed; // reads are typed too
export { read };

// @ts-expect-error — `text` is required: it cannot be cleared
draft.text = undefined;

// @ts-expect-error — lists are mutated, never reassigned
draft.tags = ["a"];

// @ts-expect-error — wrong value type on a property write
draft.completed = "yes";

export type _anchor = FieldBuilder<"string", false, false>;
export const _store = Store;

// -----------------------------------------------------------------------------
// §4.7 — object values: typed whole, replaced whole
// -----------------------------------------------------------------------------

draft.position = { x: 1, y: 2 };
draft.position = { x: 1, y: 2, z: 3 }; // optional member may appear
draft.position = undefined; // the FIELD is optional → clearing compiles

// @ts-expect-error — `y` is a required member of the shape
draft.position = { x: 1 };

// @ts-expect-error — members are typed
draft.position = { x: 1, y: "two" };

// @ts-expect-error — unknown members do not compile
draft.position = { x: 1, y: 2, w: 9 };

// @ts-expect-error — refs cannot live inside an object value (§4.7: no identity)
Schema.object({ owner: Schema.ref(User) });

// @ts-expect-error — no .multiple() inside a value: there are no triples in there
Schema.object({ tags: Schema.string().multiple() });

// §4.8 — Schema.oneOf: the literal union on the draft, on create, and in results.
const Member = Schema.from({ name: Schema.string(), role: Schema.oneOf("admin", "member", "guest") });
export const memberSchema = Schema.build({ member: Member });
{
  const tx = new Transaction(memberSchema.flat, new Store());
  const draft = tx.create(Member, { name: "Ada", role: "admin" });
  draft.role = "guest";
  // @ts-expect-error — "owner" is not one of the declared values
  draft.role = "owner";
  // @ts-expect-error — nor is any other string
  tx.create(Member, { name: "Bob", role: "" as string });
  const literal: "admin" | "member" | "guest" = draft.role;
  void literal;
}
