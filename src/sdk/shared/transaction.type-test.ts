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
