/**
 * Type-level tests for SPEC §6.5 and §4.5 — `npm run typecheck` IS the assertion.
 */

import { Query, type EntityResult, type ResultOf } from "./query.ts";
import { Schema, type FieldBuilder } from "./schema.ts";
import type { Ref } from "./types.ts";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Flat<T> = T extends object ? { [K in keyof T]: T[K] } : T;

const User = Schema.from({ name: Schema.string() });
const Todo = Schema.from({
  text: Schema.string(), // required — the default (§4.5)
  note: Schema.string().optional(),
  priority: Schema.union(Schema.string(), Schema.number()), // transitional retype (§4.5)
  tags: Schema.string().multiple(),
  owner: Schema.ref(User), // required ref
  reviewer: Schema.ref(User).optional(),
});

const q = Query.from(Todo)
  .where("owner", { id: "user_1" })
  .select({
    text: true,
    note: true,
    priority: true,
    tags: true,
    owner: { name: true },
    reviewer: true,
  });

type Row = ResultOf<typeof q>;

/** Required single → T. Optional → T | undefined. Multiple → T[]. */
type _text = Expect<Equal<Row["text"], string>>;
type _note = Expect<Equal<Row["note"], string | undefined>>;
type _tags = Expect<Equal<Row["tags"], string[]>>;

/** A union field is just a union of its members' value types. */
type _priority = Expect<Equal<Row["priority"], string | number>>;

/** A required ref followed → the nested result, present. Optional ref → | undefined. */
type _owner = Expect<Equal<Flat<Row["owner"]>, { id: string; name: string }>>;
type _reviewer = Expect<Equal<Row["reviewer"], Ref | undefined>>;

type _id = Expect<Equal<Row["id"], string>>;

/**
 * The LENIENT form (§10.2): policy contexts see every field `| undefined`,
 * because a pre-create state has no guarantees to trust.
 */
type Lenient = EntityResult<typeof Todo, { text: true; owner: true }, false>;
type _lenientText = Expect<Equal<Lenient["text"], string | undefined>>;
type _lenientOwner = Expect<Equal<Lenient["owner"], Ref | undefined>>;

// @ts-expect-error — "nope" is not a field of Todo
Query.from(Todo).where("nope", "x");

// @ts-expect-error — priority accepts string | number, not boolean
Query.from(Todo).where("priority", true);

// @ts-expect-error — cannot nest into a non-ref field
Query.from(Todo).where("text", "x").select({ text: { name: true } });

// @ts-expect-error — union members must be scalars, not refs
Schema.union(Schema.string(), Schema.ref(User));

/** §6.6 — windows: order by single scalars only. */
Query.from(Todo).where("text", "x").orderBy("text", "desc").limit(10);
Query.from(Todo).where("text", "x").orderBy("note").after({ value: null, id: "todo_1" });

// @ts-expect-error — no orderBy, no cursor: .after() needs the order's value type
Query.from(Todo).where("text", "x").after({ value: null, id: "todo_1" });

// @ts-expect-error — ordered by note (a string): a number cursor value cannot fit
Query.from(Todo).where("text", "x").orderBy("note").after({ value: 4, id: "todo_1" });

// @ts-expect-error — cannot order by a .multiple() field
Query.from(Todo).where("text", "x").orderBy("tags");

// @ts-expect-error — cannot order by a ref
Query.from(Todo).where("text", "x").orderBy("owner");

export type {
  _text, _note, _tags, _priority, _owner, _reviewer, _id, _lenientText, _lenientOwner,
};

// -----------------------------------------------------------------------------
// §6.8 — correlated subqueries: the select callback's row handle IS a ref
// -----------------------------------------------------------------------------

const withJoin = Query.from(User)
  .whereId("user_1")
  .select((user) => ({
    name: true,
    todos: Query.from(Todo).where("owner", user).select({ text: true }),
  }));

type JoinRow = ResultOf<typeof withJoin>;
type _jname = Expect<Equal<JoinRow["name"], string>>;
type _jrows = Expect<Equal<Flat<JoinRow["todos"][number]>, { id: string; text: string }>>;

export type _joinAssertions = [_jname, _jrows];

// @ts-expect-error — "nope" is neither a field of user nor a subquery
export const typoKey = Query.from(User).select({ name: true, nope: true });

export const refIntoString = Query.from(User).select((user) => ({
  // @ts-expect-error — the handle is a REF: it cannot pin a string field
  todos: Query.from(Todo).where("text", user).select({ text: true }),
}));

// -----------------------------------------------------------------------------
// §6.2/§6.9/§6.10 — the where family
// -----------------------------------------------------------------------------

Query.from(Todo).where("owner", [{ id: "user_1" }, { id: "user_2" }]); // set form
Query.from(Todo).where("owner", { id: "u" }).whereNot("text", ["a", "b"]);
Query.from(Todo).where("owner", { id: "u" }).whereAbsent("reviewer");
Query.from(Todo).where("owner", { id: "u" }).whereGreaterOrEqual("text", "m");
Query.from(Todo).where("owner", { id: "u" }).whereLesser("text", "m");
Query.from(Todo).where("owner", { id: "u" }).whereLesserOrEqual("text", "m");
Query.from(Todo).where("owner", { id: "u" }).whereBetween("text", "a", "m");
Query.from(Todo).whereEither(
  (branch) => branch.where("text", "x"),
  (branch) => branch.whereAbsent("reviewer"),
);

// @ts-expect-error — the set form still types its elements by the field
Query.from(Todo).where("text", [1, 2]);

// @ts-expect-error — ranges need an orderable scalar: refs do not rank
Query.from(Todo).whereGreater("owner", { id: "user_1" });

// @ts-expect-error — nor do .multiple() fields
Query.from(Todo).whereBetween("tags", "a", "b");

Query.from(Todo).whereEither(
  (branch) => branch.where("text", "x"),
  // @ts-expect-error — branch constraints are typed like any where
  (branch) => branch.where("text", 4),
);

// -----------------------------------------------------------------------------
// §6.8 — callbacks at REF depth: each level's handle correlates its own rows
// -----------------------------------------------------------------------------

const deepJoin = Query.from(Todo)
  .whereId("todo_1")
  .select({
    text: true,
    owner: (owner: Ref) => ({
      name: true,
      reviews: Query.from(Todo).where("reviewer", owner).select({ text: true }),
    }),
  });

type DeepRow = ResultOf<typeof deepJoin>;
type DeepOwner = Flat<DeepRow["owner"]>;
type _downer = Expect<Equal<DeepOwner["name"], string>>;
type _dreviews = Expect<Equal<Flat<DeepOwner["reviews"][number]>, { id: string; text: string }>>;

export type _depthAssertions = [_downer, _dreviews];

// -----------------------------------------------------------------------------
// §4.4 — mutually-referencing entities: thunk refs + interface annotations
// -----------------------------------------------------------------------------

// type aliases, not interfaces: only aliases carry the implicit index
// signature that EntityDef (a Record) requires.
type PersonFields = {
  name: FieldBuilder<"string", false, false>;
  dog: FieldBuilder<"ref", false, true, DogFields>;
};
type DogFields = {
  called: FieldBuilder<"string", false, false>;
  human: FieldBuilder<"ref", false, false, PersonFields>;
};
const Person: PersonFields = Schema.from({
  name: Schema.string(),
  dog: Schema.ref((): DogFields => Dog).optional(),
});
const Dog: DogFields = Schema.from({
  called: Schema.string(),
  human: Schema.ref((): PersonFields => Person),
});
export const cyclic = Schema.build({ person: Person, dog: Dog });

// traversal works in BOTH directions, through the cycle:
const throughCycle = Query.from(Person)
  .whereId("person_1")
  .select({ name: true, dog: { called: true, human: { name: true } } });
type CycleRow = ResultOf<typeof throughCycle>;
type CycleDog = Flat<NonNullable<CycleRow["dog"]>>;
type _ccalled = Expect<Equal<CycleDog["called"], string>>;
type _chuman = Expect<Equal<Flat<CycleDog["human"]>, { id: string; name: string }>>;
export type _cycleAssertions = [_ccalled, _chuman];
