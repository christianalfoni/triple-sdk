/**
 * SPEC §6 — Query.
 *
 *   const myTodos = Query.from(Todo)
 *     .where("owner", { id: userId })       // ordered — you control the plan
 *     .where("completed", false)
 *     .select({
 *       text: true,
 *       tags: true,
 *       owner: { name: true },              // follow the ref: keys are USER's fields
 *     })
 *
 * Two halves, deliberately shaped differently (SPEC §6.1):
 *
 *   .where()   a linear, ORDERED sequence of constraints — a chain fits
 *   .select()  a TREE describing the result — a nested literal fits
 *
 * All keys are BARE: the query is rooted at an entity, so the namespace is implied,
 * and nesting into a ref switches to the target entity's fields — `Schema.ref(User)`
 * carries the target in its type (SPEC §6.5). The wire still speaks namespaced
 * predicates; the builder generates them.
 */

import {
  entityName,
  fieldOf,
  predicateOf,
  refTarget,
  subjectEntityName,
  type AnyFieldBuilder,
  type EntityDef,
  type FieldBuilder,
  type FieldType,
  type Schema,
} from "./schema.ts";
import type { Id, ObjectValue, Pattern, Readable, Ref, Triple, Value } from "./types.ts";
import { encodeValue, isRef, tripleKey } from "./value.ts";

// -----------------------------------------------------------------------------
// Type-level plumbing (SPEC §6.5)
// -----------------------------------------------------------------------------

/** A field's declared type → the JS type it holds. */
export type ValueOfType<T extends FieldType> = T extends "string"
  ? string
  : T extends "number"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "ref"
        ? Ref
        : T extends "object"
          ? ObjectValue // untyped fallback; ValueOfField derives the real shape
          : never;

/** §4.7 — the TS type an object field's declared shape produces. */
export type ObjectValueOf<S> = {
  [K in keyof S as S[K] extends FieldBuilder<FieldType, false, false, unknown>
    ? K
    : never]: ValueOfField<S[K]>;
} & {
  [K in keyof S as S[K] extends FieldBuilder<FieldType, false, true, unknown>
    ? K
    : never]?: ValueOfField<S[K]>;
};

/** The value type a field builder accepts and yields — a `oneOf` yields its literal union (§4.8). */
export type ValueOfField<B> =
  B extends FieldBuilder<infer T, boolean, boolean, infer R, infer L>
    ? unknown extends L
      ? T extends "object"
        ? ObjectValueOf<R>
        : ValueOfType<T>
      : L
    : never;

/** Fields a window may order by: single-valued scalars (refs and lists cannot rank). */
type OrderableKeys<F> = {
  [K in keyof F]: F[K] extends FieldBuilder<
    "string" | "number" | "boolean",
    false,
    boolean,
    unknown
  >
    ? K
    : never;
}[keyof F];

/**
 * What may be selected from an entity: its fields, with refs nesting into their
 * TARGET entity's selection. This one recursive type serves queries (§6) and policy
 * contexts (§10.2) alike.
 */
export type EntitySelection<E extends EntityDef> = {
  [K in keyof E]?: E[K] extends FieldBuilder<
    "ref",
    boolean,
    boolean,
    infer R
  >
    ? R extends EntityDef
      ? true | EntitySelection<R>
      : true
    : true;
};

/**
 * The shape a selection produces. Keys are the bare field names — there is no
 * namespace to strip, because the selection was scoped to an entity all along.
 *
 * `Strict` (the default) trusts §4.5: a required single field types as `T`, an
 * `.optional()` one as `T | undefined`, a multiple as `T[]`. Policy contexts use
 * the lenient form (`Strict = false`, everything `| undefined`) because they may
 * be looking at a pre-create state where the guarantees do not hold yet (§10.2).
 */
export type EntityResult<
  E extends EntityDef,
  Sel,
  Strict extends boolean = true,
> = { id: Id } & {
  [K in keyof Sel & keyof E & string]: FieldResult<
    E[K],
    Sel[K],
    Strict
  >;
} & {
  // §6.8 — selection keys that are NOT fields hold correlated subqueries; each
  // yields an ARRAY of that query's rows.
  [K in Exclude<keyof Sel & string, keyof E>]: Sel[K] extends QueryBuilder<
    infer T,
    infer TSel,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >
    ? EntityResult<T, TSel, Strict>[]
    : never;
};

type Presence<V, O, Strict> = Strict extends true
  ? O extends true
    ? V | undefined
    : V
  : V | undefined;

/**
 * One field's type in a result. `multiple` decides array vs scalar and `optional`
 * decides `| undefined`, mirroring the runtime rules (§6.3, §4.5) so the static
 * type and the value cannot disagree.
 */
type FieldResult<B, Sel, Strict extends boolean> =
  B extends FieldBuilder<FieldType, infer M, infer O, infer R>
    ? Sel extends boolean // `true` in the source; widened inside nested callbacks
      ? M extends true
        ? ValueOfField<B>[]
        : Presence<ValueOfField<B>, O, Strict>
      : R extends EntityDef
        ? Sel extends (row: Ref) => infer Nested // §6.8 — callback at ref depth
          ? M extends true
            ? EntityResult<R, Nested, Strict>[]
            : Presence<EntityResult<R, Nested, Strict>, O, Strict>
          : M extends true
            ? EntityResult<R, Sel, Strict>[]
            : Presence<EntityResult<R, Sel, Strict>, O, Strict>
        : never
    : never;

/** The result type of a built query: `type Todo = ResultOf<typeof myTodos>`. */
export type ResultOf<Q> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Q extends QueryBuilder<infer E, infer Sel, any> ? EntityResult<E, Sel> : never;

// -----------------------------------------------------------------------------
// Builder
// -----------------------------------------------------------------------------

export type Constraint =
  | { predicate: string; value: Value }
  | {
      predicate: string;
      /** §6.2 — set form of `where`: match if the field holds ANY of these. */
      anyOf: readonly Value[];
    }
  | {
      predicate: string;
      /** §6.9 — `whereNot`: drop subjects holding any of these. Refinement only. */
      not: readonly Value[];
    }
  | {
      predicate: string;
      /** §6.9 — `whereAbsent`: drop subjects holding ANY value here. Refinement only. */
      absent: true;
    }
  | {
      predicate: string;
      /** §6.9 — `whereGreater`/`whereLess`/`whereBetween`, on encoded order (§6.6). */
      range: { gt?: Value; gte?: Value; lt?: Value; lte?: Value };
    }
  | {
      /** §6.10 — `whereEither`: a subject survives if ANY branch fully matches. */
      either: readonly (readonly Constraint[])[];
    }
  | {
      predicate: string;
      /** §6.8 — "the value is the PARENT row's ref". Substituted per root. */
      parent: true;
    };

/** Narrow a constraint to the set form of `where` (§6.2). */
export function isAnyOf(
  constraint: Constraint,
): constraint is { predicate: string; anyOf: readonly Value[] } {
  return "anyOf" in constraint;
}

/** §6.2/§6.9 — may this constraint SEED a query (find roots on its own)? */
function canSeed(constraint: Constraint): boolean {
  return "value" in constraint || "anyOf" in constraint || "range" in constraint;
}

/** The predicates of every NEGATION inside a constraint (either-branches recurse). */
function negationPredicates(constraint: Constraint, into: Set<string>): void {
  if ("either" in constraint) {
    for (const branch of constraint.either) {
      for (const entry of branch) negationPredicates(entry, into);
    }
  } else if ("not" in constraint || "absent" in constraint) {
    into.add(constraint.predicate);
  }
}

/**
 * §6.9 — how a negation stays SOUND on a partial cache (§7.6): the client
 * re-derives roots from whatever its cache holds, and a missing triple there
 * looks exactly like absence. So the server ships the negation predicate's
 * readable triples for every subject that reached the negation — a superset of
 * anything the client can seed — and the client then judges from evidence, not
 * from silence. Deltas keep it current (§6.4: negated predicates are watched).
 */
type NegationEvidence = (subjects: Id[], predicate: string) => void;

/** Every predicate a constraint touches (either-branches recurse). */
function constraintPredicates(constraint: Constraint, into: Set<string>): void {
  if ("either" in constraint) {
    for (const branch of constraint.either) {
      for (const entry of branch) constraintPredicates(entry, into);
    }
  } else {
    into.add(constraint.predicate);
  }
}

/** Narrow a constraint: correlated ones only appear inside subqueries. */
export function isCorrelated(
  constraint: Constraint,
): constraint is { predicate: string; parent: true } {
  return "parent" in constraint;
}

/** Deeply: does any constraint (into either-branches) carry a parent marker? */
function anyCorrelated(constraints: readonly Constraint[]): boolean {
  return constraints.some((constraint) =>
    "either" in constraint
      ? constraint.either.some((branch) => anyCorrelated(branch))
      : isCorrelated(constraint),
  );
}

/** The executor's untyped, NAMESPACED view of a selection — what travels the wire. */
export type RuntimeSelection = { [predicate: string]: true | RuntimeSelection };

/**
 * The serializable core of a query — what actually travels to the server (§7.5).
 * Predicates are namespaced here; entities exist only in the builder's types.
 */
/** §6.8 — one correlated subquery on the wire: caller-named, a full payload,
 * attached at `path` (ref predicates from the root; absent = the root itself). */
export type RuntimeSubquery = {
  key: string;
  path?: readonly string[];
  payload: QueryPayload;
};

export type QueryPayload = {
  /** §6.7 — pin to one known subject ("load this entity"). */
  subject?: Id;
  /** §6.8 — correlated subqueries, one result array per key on every row. */
  subqueries?: readonly RuntimeSubquery[];
  /**
   * §6.2 — no positive seed (no constraint at all, or a negation first): the
   * roots are EVERY instance of the entity, found as every subject holding any
   * of these predicates — a required one when the entity has one (every
   * instance holds it, §4.5), else all of its predicates.
   */
  all?: readonly string[];
  constraints: readonly Constraint[];
  selection: RuntimeSelection;
  /** §6.6 — a window: explicit order (the set has none), keyset cursor, size. */
  order?: { predicate: string; direction: "asc" | "desc" };
  after?: { value: Value | null; id: Id };
  limit?: number;
};

/**
 * Immutable, like `FieldBuilder` (§4) — every method returns a new builder, so a
 * query held in a variable can be extended without altering the original.
 */
export type QueryWindow = {
  order?: { predicate: string; direction: "asc" | "desc" };
  after?: { value: Value | null; id: Id };
  limit?: number;
};

/**
 * §6.8 — the handle a `.select((row) => …)` callback receives — at ANY ref
 * level: nested ref selections may be callbacks too, each receiving the handle
 * of ITS row. A handle IS a ref value (`{ id }`), so it slots straight into a
 * subquery's `.where("team", row)` — refs are `{ id }` objects, and the
 * correlation is "this field points at the row being built at this level".
 * Fresh and frozen per callback; `toPayload` recognizes handles by identity, so
 * pass them as-is (spreading one makes an ordinary — and bogus — ref).
 */
function makeRowHandle(): Ref {
  return Object.freeze({ id: "(the row being built)" });
}

/** A selection value may be a nested selection or a correlated subquery. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySubquery = QueryBuilder<any, any, any>;

/**
 * What each key of a selection must be, judged per key: a real field follows the
 * field's own rules (`true`, or a nested selection for refs); an UNKNOWN key must
 * hold a correlated subquery — so a typo'd field name errors, naming the key.
 */
export type SelectionShape<E extends EntityDef, S> = {
  // `boolean` rather than `true`: a NESTED callback's return is outside `const`
  // inference, so its `true` literals widen — the runtime insists on `true`.
  [K in keyof S]: K extends keyof E
    ? E[K] extends FieldBuilder<"ref", boolean, boolean, infer R>
      ? R extends EntityDef
        ? S[K] extends (row: Ref) => infer Nested
          ? (row: Ref) => SelectionShape<R, Nested> // §6.8 — a callback at ref depth
          : boolean | SelectionShape<R, S[K]>
        : boolean
      : boolean
    : AnySubquery;
};

/** One lifted subquery: where it attaches (path of ref predicates) and whose
 * handle its correlations may use (that level's — cross-level is refused). */
export type SubqueryEntry = {
  key: string;
  builder: AnySubquery;
  /** Namespaced ref predicates from the root to the attachment level. */
  path: readonly string[];
  /** The handle handed to the callback at this level, if there was one. */
  handle?: Ref;
  /** Every handle minted for this select — to catch cross-level references. */
  handles: ReadonlySet<Ref>;
};

/**
 * §6.8 — walk a selection (object or callback form), at every level splitting
 * plain fields from subqueries and recursing into ref values, which may
 * THEMSELVES be callbacks receiving that level's row handle.
 */
function processSelection(
  entity: EntityDef,
  input: unknown,
  path: readonly string[],
  handles: Set<Ref>,
): { fields: Record<string, unknown>; subqueries: SubqueryEntry[] } {
  let handle: Ref | undefined;
  let node = input;
  if (typeof node === "function") {
    handle = makeRowHandle();
    handles.add(handle);
    node = (node as (row: Ref) => unknown)(handle);
  }
  const fields: Record<string, unknown> = {};
  const subqueries: SubqueryEntry[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (value instanceof QueryBuilder) {
      if ((entity as Record<string, unknown>)[key] !== undefined) {
        throw new Error(
          `"${key}" is a field of ${entityName(entity)} — a subquery needs its own name.`,
        );
      }
      subqueries.push({ key, builder: value as AnySubquery, path, handle, handles });
      continue;
    }
    if (value === true) {
      fields[key] = true;
      continue;
    }
    // A nested object or callback: only legal on a ref, into its target.
    const builder = (entity as Record<string, AnyFieldBuilder>)[key];
    const target = builder === undefined ? undefined : refTarget(builder);
    if (!builder || builder.field.type !== "ref" || !target) {
      throw new Error(
        `Cannot select into "${entityName(entity)}.${key}": it is not a ref.`,
      );
    }
    const nested = processSelection(target, value, [...path, predicateOf(entity, key)], handles);
    fields[key] = nested.fields;
    subqueries.push(...nested.subqueries);
  }
  return { fields, subqueries };
}

export class QueryBuilder<
  E extends EntityDef,
  Sel,
  OrderK extends (keyof E & string) | undefined = undefined,
> {
  constructor(
    readonly entity: E,
    readonly constraints: readonly Constraint[],
    readonly selection: Sel,
    readonly window: QueryWindow = {},
    readonly subject?: Id,
    readonly subqueries: readonly SubqueryEntry[] = [],
  ) {}

  /**
   * §6.7 — pin the query to ONE known subject: "load this entity". The id prefix
   * must match the entity (§4.6), checked eagerly. Combines with `.where()` (the
   * pinned subject must still satisfy every constraint) and needs no window: the
   * result has at most one row. An invisible or absent subject yields zero rows —
   * indistinguishable, by design (§0.3, §10.5).
   */
  whereId(id: Id): QueryBuilder<E, Sel, OrderK> {
    if (subjectEntityName(id) !== entityName(this.entity)) {
      throw new Error(
        `Subject "${id}" is a ${subjectEntityName(id)} — Query.from(${entityName(this.entity)}) cannot load it.`,
      );
    }
    return new QueryBuilder(this.entity, this.constraints, this.selection, this.window, id, this.subqueries);
  }

  /**
   * Narrow to subjects holding this value for this field — or, given an ARRAY,
   * any of them (the IN of the system). One symmetric rule: match if the field's
   * values and the given values intersect. An empty array matches nothing, and
   * an array is never ambiguous here: no field ever HOLDS an array (§4.1 — even
   * `.multiple()` is many scalar triples).
   *
   * ORDER IS PRESERVED AND IT MATTERS. Constraints run in the order you write them,
   * each filtering what survived the last, so the most selective belongs first.
   * There is no query planner — you are the planner (SPEC §6.2).
   */
  where<K extends keyof E & string>(
    field: K,
    value: ValueOfField<E[K]> | readonly ValueOfField<E[K]>[],
  ): QueryBuilder<E, Sel, OrderK> {
    const predicate = predicateOf(this.entity, field);
    return new QueryBuilder(
      this.entity,
      [
        ...this.constraints,
        Array.isArray(value)
          ? { predicate, anyOf: value as Value[] }
          : { predicate, value: value as Value },
      ],
      this.selection,
      this.window,
      this.subject,
      this.subqueries,
    );
  }

  /**
   * §6.6 — give the result an explicit order. The store is a SET (§0.1): "first"
   * means nothing until you say by what. Missing values sort last either way; ties
   * break on subject id, so the order is total and stable.
   */
  orderBy<K extends OrderableKeys<E> & string>(
    field: K,
    direction: "asc" | "desc" = "asc",
  ): QueryBuilder<E, Sel, K> {
    return new QueryBuilder(
      this.entity,
      this.constraints,
      this.selection,
      { ...this.window, order: { predicate: predicateOf(this.entity, field), direction } },
      this.subject,
      this.subqueries,
    );
  }

  /** §6.6 — window size. The server collects triples for the window ONLY. */
  limit(count: number): QueryBuilder<E, Sel, OrderK> {
    return new QueryBuilder(
      this.entity,
      this.constraints,
      this.selection,
      { ...this.window, limit: count },
      this.subject,
      this.subqueries,
    );
  }

  /**
   * §6.9 — drop subjects HOLDING this value (or any of an array). A refinement,
   * never a seed: you cannot scan for what is missing (§0.3) — put a positive
   * `.where()` first. A policy-hidden triple already reads as absent (§10.5), so
   * "not" and visibility agree by construction.
   */
  whereNot<K extends keyof E & string>(
    field: K,
    value: ValueOfField<E[K]> | readonly ValueOfField<E[K]>[],
  ): QueryBuilder<E, Sel, OrderK> {
    const values = (Array.isArray(value) ? value : [value]) as Value[];
    return this.#withConstraint({ predicate: predicateOf(this.entity, field), not: values });
  }

  /** §6.9 — drop subjects holding ANY value for this field. Refinement, never a seed. */
  whereAbsent<K extends keyof E & string>(field: K): QueryBuilder<E, Sel, OrderK> {
    return this.#withConstraint({ predicate: predicateOf(this.entity, field), absent: true });
  }

  /**
   * §6.9 — keep subjects with a value STRICTLY above this one. Rides the
   * order-preserving encoding (§6.6), so it works for strings and numbers alike,
   * and single scalars only — refs and lists do not rank. Four explicit methods,
   * no option flags: the comparison IS the name.
   */
  whereGreater<K extends OrderableKeys<E> & string>(
    field: K,
    value: ValueOfField<E[K]>,
  ): QueryBuilder<E, Sel, OrderK> {
    return this.#withConstraint({
      predicate: predicateOf(this.entity, field),
      range: { gt: value as Value },
    });
  }

  /** §6.9 — at or above this value. */
  whereGreaterOrEqual<K extends OrderableKeys<E> & string>(
    field: K,
    value: ValueOfField<E[K]>,
  ): QueryBuilder<E, Sel, OrderK> {
    return this.#withConstraint({
      predicate: predicateOf(this.entity, field),
      range: { gte: value as Value },
    });
  }

  /** §6.9 — strictly below this value. */
  whereLesser<K extends OrderableKeys<E> & string>(
    field: K,
    value: ValueOfField<E[K]>,
  ): QueryBuilder<E, Sel, OrderK> {
    return this.#withConstraint({
      predicate: predicateOf(this.entity, field),
      range: { lt: value as Value },
    });
  }

  /** §6.9 — at or below this value. */
  whereLesserOrEqual<K extends OrderableKeys<E> & string>(
    field: K,
    value: ValueOfField<E[K]>,
  ): QueryBuilder<E, Sel, OrderK> {
    return this.#withConstraint({
      predicate: predicateOf(this.entity, field),
      range: { lte: value as Value },
    });
  }

  /** §6.9 — keep subjects with a value in [from, to] — both ends INCLUSIVE. */
  whereBetween<K extends OrderableKeys<E> & string>(
    field: K,
    from: ValueOfField<E[K]>,
    to: ValueOfField<E[K]>,
  ): QueryBuilder<E, Sel, OrderK> {
    return this.#withConstraint({
      predicate: predicateOf(this.entity, field),
      range: { gte: from as Value, lte: to as Value },
    });
  }

  /**
   * §6.10 — OR across DIFFERENT conditions: a subject survives if ANY branch
   * matches in full. Each branch is an ordinary constraint chain on this entity
   * (ANDs inside, OR between), and the whole `whereEither` ANDs with the rest of
   * the chain like any other constraint. For "one of these VALUES of one field",
   * pass an array to `.where()` instead.
   */
  whereEither(
    ...branches: readonly ((
      branch: QueryBuilder<E, Record<string, never>>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) => QueryBuilder<E, unknown, any>)[]
  ): QueryBuilder<E, Sel, OrderK> {
    if (branches.length < 2) {
      throw new Error("whereEither needs at least two branches — one branch is just .where().");
    }
    const either = branches.map((build) => {
      const built = build(new QueryBuilder(this.entity, [], {}));
      if (built.constraints.length === 0) {
        throw new Error("A whereEither branch needs at least one constraint.");
      }
      if (built.subject !== undefined || built.subqueries.length > 0 || built.window.order || built.window.limit) {
        throw new Error("A whereEither branch carries constraints only — no whereId, windows or subqueries.");
      }
      return built.constraints;
    });
    return this.#withConstraint({ either });
  }

  /** Append one constraint, preserving everything else. */
  #withConstraint(constraint: Constraint): QueryBuilder<E, Sel, OrderK> {
    return new QueryBuilder(
      this.entity,
      [...this.constraints, constraint],
      this.selection,
      this.window,
      this.subject,
      this.subqueries,
    );
  }

  /**
   * §6.6 — keyset cursor: rows sorting strictly after (value, id). Offset breaks
   * under concurrent writes; a value cursor does not. Build "load more" as stacked
   * queries, each cursored on the previous page's last row — `LiveQuery.cursor`
   * hands it to you. The value's TYPE comes from `orderBy`, which is also why
   * `.after()` before `.orderBy()` is a compile error: no order, no cursor.
   */
  after(
    cursor: OrderK extends keyof E & string
      ? { value: ValueOfField<E[OrderK]> | null; id: Id }
      : never,
  ): QueryBuilder<E, Sel, OrderK> {
    return new QueryBuilder(
      this.entity,
      this.constraints,
      this.selection,
      { ...this.window, after: { value: cursor.value as Value | null, id: cursor.id } },
      this.subject,
      this.subqueries,
    );
  }

  /**
   * Describe the result shape. Replaces any previous selection.
   *
   * §6.8 — the CALLBACK form additionally receives the row being built, as a ref:
   * unknown keys may then hold correlated subqueries, ordinary queries whose
   * `.where("team", row)` pins a ref field to that row. Each yields an array of
   * its rows on the result — filtered, ordered and windowed PER PARENT ROW.
   */
  select<const NewSel extends SelectionShape<E, NewSel>>(
    // The top-level callback's `row` types itself; a NESTED callback must
    // annotate its handle — `owner: (owner: Ref) => ({ … })` — because inside an
    // inferred literal TypeScript has no non-circular contextual type for it.
    selection: NewSel | ((row: Ref) => NewSel),
  ): QueryBuilder<E, NewSel, OrderK> {
    // Runtime selection = the plain fields tree; subqueries — at any depth — are
    // lifted out with the PATH to their attachment level and the handle of that
    // level. The markers live on in the TYPE (for EntityResult).
    const { fields, subqueries } = processSelection(this.entity, selection, [], new Set());
    return new QueryBuilder(
      this.entity,
      this.constraints,
      fields as NewSel,
      this.window,
      this.subject,
      subqueries,
    );
  }
}

export const Query = {
  /** A query is rooted at an entity, which is where its types come from (§6.5). */
  from<E extends EntityDef>(entity: E): QueryBuilder<E, {}> {
    return new QueryBuilder(entity, [], {});
  },
};

/** Strip a built query down to its wire form, namespacing the selection. */
export function toPayload(query: AnySubquery): QueryPayload {
  // A positive first constraint (or a correlation, bound to one per parent)
  // seeds through the index; anything else means every instance (§6.2).
  const first = query.constraints[0];
  const seeded = first !== undefined && (canSeed(first) || isCorrelated(first));
  return {
    ...(query.subject !== undefined ? { subject: query.subject } : {}),
    ...(query.subject === undefined && !seeded ? { all: instancePredicates(query.entity) } : {}),
    ...(query.subqueries.length > 0
      ? {
          subqueries: query.subqueries.map((entry) => ({
            key: entry.key,
            ...(entry.path.length > 0 ? { path: entry.path } : {}),
            payload: toPayload(markCorrelated(entry)),
          })),
        }
      : {}),
    constraints: query.constraints,
    selection: namespaceSelection(
      query.entity,
      query.selection as Record<string, unknown>,
    ),
    ...query.window,
  };
}

/**
 * §6.2 — the predicates that, together, find every instance of an entity: one
 * required field when there is one (every instance holds it, §4.5), else all
 * of its fields, since an instance is whichever of them it holds.
 */
function instancePredicates(entity: EntityDef): string[] {
  const fields = Object.entries(entity) as [string, AnyFieldBuilder][];
  const required = fields.filter(([, builder]) => !builder.field.multiple && !builder.field.optional);
  return (required.length > 0 ? [required[0]!] : fields).map(([field]) => predicateOf(entity, field));
}

/**
 * §6.8 — inside a subquery, a `.where(field, row)` holding the handle OF ITS
 * attachment level (by identity) becomes a correlated constraint on the wire.
 * A handle from ANOTHER level is refused — a subquery may only reference the
 * row it is attached to. Values merely shaped like a handle stay ordinary refs.
 */
function markCorrelated(entry: SubqueryEntry): AnySubquery {
  const { builder, handle, handles } = entry;
  const isForeignHandle = (value: unknown): boolean =>
    handles.has(value as Ref) && value !== handle;
  const mark = (constraint: Constraint): Constraint => {
    if ("either" in constraint) {
      return { either: constraint.either.map((branch) => branch.map(mark)) };
    }
    if (isAnyOf(constraint)) {
      if (constraint.anyOf.some((value) => handles.has(value as Ref))) {
        throw new Error(
          "A row handle cannot be ONE OF several values — give it its own .where().",
        );
      }
      return constraint;
    }
    if ("not" in constraint) {
      if (constraint.not.some((value) => handles.has(value as Ref))) {
        throw new Error("A row handle inside whereNot is not supported (yet).");
      }
      return constraint;
    }
    if ("value" in constraint && isForeignHandle(constraint.value)) {
      throw new Error(
        "A subquery may only reference the row it is ATTACHED to — this handle belongs to another level.",
      );
    }
    if ("value" in constraint && handle !== undefined && constraint.value === handle) {
      return { predicate: constraint.predicate, parent: true as const };
    }
    return constraint;
  };
  return new QueryBuilder(
    builder.entity,
    builder.constraints.map(mark),
    builder.selection,
    builder.window,
    builder.subject,
    builder.subqueries,
  );
}

/** §6.8 — resolve a subquery's correlated constraints against ONE parent row. */
function bindParent(payload: QueryPayload, parent: Id): QueryPayload {
  const bind = (constraint: Constraint): Constraint =>
    "either" in constraint
      ? { either: constraint.either.map((branch) => branch.map(bind)) }
      : isCorrelated(constraint)
        ? { predicate: constraint.predicate, value: { id: parent } }
        : constraint;
  return { ...payload, constraints: payload.constraints.map(bind) };
}

/** `{ text: true, owner: { name: true } }` on Todo → `{ "todo/text": true, ... }`. */
function namespaceSelection(
  entity: EntityDef,
  selection: Record<string, unknown>,
): RuntimeSelection {
  const out: RuntimeSelection = {};
  for (const [field, sub] of Object.entries(selection)) {
    const builder = entity[field] as AnyFieldBuilder | undefined;
    if (!builder) {
      throw new Error(`Entity "${entityName(entity)}" has no field "${field}".`);
    }
    if (sub === true) {
      out[predicateOf(entity, field)] = true;
      continue;
    }
    const target = refTarget(builder);
    if (!target) {
      throw new Error(
        `Cannot select into "${entityName(entity)}.${field}": it is not a ref.`,
      );
    }
    out[predicateOf(entity, field)] = namespaceSelection(
      target,
      sub as Record<string, unknown>,
    );
  }
  return out;
}

/**
 * Every predicate a query touches — constraints plus the whole selection tree.
 * This is what makes reactivity cheap (§6.4): a delta only re-runs the live
 * queries whose predicate set it intersects.
 */
export function queryPredicates(payload: QueryPayload): Set<string> {
  const predicates = new Set<string>();
  for (const constraint of payload.constraints) constraintPredicates(constraint, predicates);
  // An every-instance seed watches its seed predicate: a new instance arrives
  // as that predicate's triple, and the list must re-run.
  for (const predicate of payload.all ?? []) predicates.add(predicate);

  const walk = (selection: RuntimeSelection): void => {
    for (const [predicate, sub] of Object.entries(selection)) {
      predicates.add(predicate);
      if (sub !== true) walk(sub);
    }
  };
  walk(payload.selection);
  for (const subquery of payload.subqueries ?? []) {
    for (const predicate of queryPredicates(subquery.payload)) predicates.add(predicate);
  }

  return predicates;
}

// -----------------------------------------------------------------------------
// Execution
// -----------------------------------------------------------------------------

/**
 * Run a built query against a local store. `schema` is the flat predicate map —
 * the executor never sees an entity, only generated predicates.
 */
export function runQuery<E extends EntityDef, Sel>(
  store: Readable,
  schema: Schema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: QueryBuilder<E, Sel, any>,
): EntityResult<E, Sel>[] {
  return runPayload(store, schema, toPayload(query)) as EntityResult<E, Sel>[];
}

/**
 * §6.6 — total order over possibly-missing values: within-type comparison, types
 * ranked by tag for union fields, MISSING ALWAYS LAST regardless of direction,
 * subject id as the final tiebreak.
 */
function compareOrderValues(a: Value | undefined, b: Value | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  const ia = (a as Ref).id;
  const ib = (b as Ref).id;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/**
 * Order, cursor and limit applied to resolved roots — the same code on both sides,
 * so the client's local window agrees with the one the server shipped.
 */
export function applyWindow(
  store: Readable,
  roots: Id[],
  payload: QueryPayload,
  canRead: ReadFilter = VISIBLE,
): Id[] {
  const { order, after, limit } = payload;
  if (!order) return limit !== undefined ? roots.slice(0, limit) : roots;

  const sign = order.direction === "desc" ? -1 : 1;
  const afterValue = after ? (after.value === null ? undefined : after.value) : undefined;
  const beats = (a: Value | undefined, b: Value | undefined, idA: Id, idB: Id): number => {
    // Missing stays last in either direction; only defined pairs flip for desc.
    const base =
      a !== undefined && b !== undefined
        ? sign * compareOrderValues(a, b)
        : compareOrderValues(a, b);
    return base !== 0 ? base : idA < idB ? -1 : idA > idB ? 1 : 0;
  };
  const pastCursor = (value: Value | undefined, id: Id): boolean =>
    after === undefined || beats(value, afterValue, id, after.id) > 0;

  // §6.6 fast path: a limited, ordered window over many roots. The adapter ranks
  // by the order-preserving encoding and returns only the top — SQL does the sort,
  // JS only re-checks visibility. Overfetch covers policy-hidden values; anything
  // stranger (window larger than the valued rows) falls back to the full path.
  if (limit !== undefined && store.topSubjects && roots.length > limit * 4) {
    const take = limit * 2 + 16;
    const top = store.topSubjects(
      roots,
      order.predicate,
      order.direction,
      take,
      after ? { key: encodeValue(afterValue ?? ""), id: after.id } : undefined,
    );
    canRead.preload?.(top.map((t) => t[0]));
    const visible = top.filter(canRead).map((t) => t[0]).slice(0, limit);
    if (visible.length >= limit || top.length < take) return visible;
  }

  // General path: fetch order values once, then a BOUNDED top-K selection —
  // O(n·log k) instead of sorting all n roots to keep k.
  const values = new Map<Id, Value>();
  for (const triple of matchAll(store, roots, order.predicate)) {
    if (canRead(triple)) values.set(triple[0], triple[2]);
  }

  const candidates = roots.filter((id) => pastCursor(values.get(id), id));
  if (limit === undefined || candidates.length <= limit) {
    return candidates.sort((x, y) => beats(values.get(x), values.get(y), x, y)).slice(0, limit);
  }

  const top: Id[] = [];
  for (const id of candidates) {
    const value = values.get(id);
    if (top.length === limit && beats(value, values.get(top[limit - 1]!), id, top[limit - 1]!) >= 0) {
      continue;
    }
    // binary insert into the bounded window
    let lo = 0;
    let hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats(value, values.get(top[mid]!), id, top[mid]!) < 0) hi = mid;
      else lo = mid + 1;
    }
    top.splice(lo, 0, id);
    if (top.length > limit) top.pop();
  }
  return top;
}

/** The untyped executor. Used by the server, which has a payload, not a builder. */
export function runPayload(
  store: Readable,
  schema: Schema,
  payload: QueryPayload,
): Record<string, unknown>[] {
  const roots = applyWindow(
    store,
    wholeOnly(store, schema, payload, resolveRoots(store, payload)),
    payload,
  );
  return roots.map((subject) => {
    const row = materialize(store, schema, subject, payload.selection);
    for (const subquery of payload.subqueries ?? []) {
      // A full query per attachment row — the ROOT, or every row at `path` (a
      // nested callback level). Correlations bind to that row; the subquery's
      // own order/limit apply per row; without an order, sort by id so the
      // array is deterministic across adapters (the store is a set, §0.1).
      for (const target of rowsAtPath(row, subquery.path ?? [])) {
        const bound = bindParent(subquery.payload, target.id as Id);
        const rows = runPayload(store, schema, bound);
        if (bound.order === undefined) {
          rows.sort((a, b) => (String(a.id) < String(b.id) ? -1 : a.id === b.id ? 0 : 1));
        }
        target[subquery.key] = rows;
      }
    }
    return row;
  });
}

/** §6.8 — the materialized row objects sitting at `path` below one root row. */
function rowsAtPath(
  root: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown>[] {
  let level: Record<string, unknown>[] = [root];
  for (const predicate of path) {
    const key = resultKey(predicate);
    const next: Record<string, unknown>[] = [];
    for (const row of level) {
      const value = row[key];
      if (Array.isArray(value)) next.push(...(value as Record<string, unknown>[]));
      else if (value !== undefined) next.push(value as Record<string, unknown>);
    }
    level = next;
  }
  return level;
}

/**
 * A per-triple visibility test. Supplied by the server from its policy (§10); the
 * client passes nothing, because its cache is already filtered (§7.6).
 */
/**
 * §7.6 — a root must be WHOLE for what the query reads: every required field it
 * constrains on or selects must be present in the store. The server keeps every
 * subject whole as a write invariant (§4.5), so there the filter passes
 * everything. A client's cache is partial in two ways, and the rule must tell
 * them apart: a query legitimately holds only the fields it asked for (§7.5),
 * which is fine — but a pushed delta for an entity it never queried leaves a lone
 * triple behind, and a later query seeding from that triple would materialize a
 * row missing a field its type promises. Checking only the fields the query
 * reads hides exactly the second case: the stray subject stays invisible until
 * the query's own fetch completes it, while a row fetched by any query is whole
 * by construction. A freshly created entity appears at once, since a create
 * carries every required field in one delta.
 */
function wholeOnly(
  store: Readable,
  schema: Schema,
  payload: QueryPayload,
  roots: Id[],
): Id[] {
  const read = rootPredicates(payload);
  const required = requiredPredicates(schema, payloadEntity(payload)).filter((predicate) =>
    read.has(predicate),
  );
  if (required.length === 0) return roots;
  return roots.filter((subject) =>
    required.every((predicate) => store.match([subject, predicate, undefined]).length > 0),
  );
}

/** The root entity's predicates this payload reads: its constraints and its own selection keys. */
function rootPredicates(payload: QueryPayload): Set<string> {
  const predicates = new Set<string>([...Object.keys(payload.selection), ...(payload.all ?? [])]);
  const walk = (constraints: readonly Constraint[]): void => {
    for (const constraint of constraints) {
      if ("either" in constraint) constraint.either.forEach(walk);
      else predicates.add(constraint.predicate);
    }
  };
  walk(payload.constraints);
  return predicates;
}

/** The entity a payload is rooted at — every predicate in it carries the name. */
function payloadEntity(payload: QueryPayload): string {
  const predicate = firstPredicate(payload.constraints) ?? Object.keys(payload.selection)[0];
  if (predicate !== undefined) return predicate.slice(0, predicate.indexOf("/"));
  return payload.subject !== undefined ? subjectEntityName(payload.subject) : "";
}

function firstPredicate(constraints: readonly Constraint[]): string | undefined {
  for (const constraint of constraints) {
    if (!("either" in constraint)) return constraint.predicate;
    for (const branch of constraint.either) {
      const predicate = firstPredicate(branch);
      if (predicate !== undefined) return predicate;
    }
  }
  return undefined;
}

const requiredByEntity = new WeakMap<Schema, Map<string, string[]>>();

/** The predicates of an entity's required fields (single, not optional), memoized per schema. */
function requiredPredicates(schema: Schema, entity: string): string[] {
  let byEntity = requiredByEntity.get(schema);
  if (!byEntity) requiredByEntity.set(schema, (byEntity = new Map()));
  let required = byEntity.get(entity);
  if (required === undefined) {
    const prefix = `${entity}/`;
    required = Object.entries(schema)
      .filter(([predicate, field]) => predicate.startsWith(prefix) && !field.multiple && !field.optional)
      .map(([predicate]) => predicate);
    byEntity.set(entity, required);
  }
  return required;
}

export type ReadFilter = ((triple: Triple) => boolean) & {
  /** Bulk-load the policy contexts for these subjects before filtering (§11.4). */
  preload?: (subjects: Id[]) => void;
};

const VISIBLE: ReadFilter = () => true;

/** Batch read with graceful fallback for stores without `matchSubjects`. */
function matchAll(store: Readable, subjects: Id[], predicate: Id): Triple[] {
  if (store.matchSubjects) return store.matchSubjects(subjects, predicate);
  const out: Triple[] = [];
  for (const subject of subjects) {
    for (const triple of store.match([subject, predicate, undefined])) out.push(triple);
  }
  return out;
}

/**
 * Every triple needed to answer this query LOCALLY — the constraint triples that
 * identify the roots, plus the selection triples, recursing through refs.
 *
 * This is what the server sends back (§7.5). The client applies them to its store
 * and then materializes with the same code the server would have used, which is why
 * a local write can update the result without another round trip.
 */
export function collectPayloadTriples(
  store: Readable,
  payload: QueryPayload,
  canRead: ReadFilter = VISIBLE,
): Triple[] {
  const collected = new Map<string, Triple>();
  const keep = (triple: Triple) => collected.set(tripleKey(triple), triple);

  const roots = windowedRoots(store, payload, canRead, (subjects, predicate) => {
    // §6.9 — negation evidence: ALL readable values of the negated predicate for
    // every subject that reached the negation, so the client judges from
    // evidence rather than from what its partial cache happens to lack.
    for (const triple of matchAll(store, subjects, predicate)) {
      if (canRead(triple)) keep(triple);
    }
  });

  // The window's ORDER-FIELD triples travel too, so the client sorts identically.
  if (payload.order) {
    for (const triple of matchAll(store, roots, payload.order.predicate)) {
      if (canRead(triple)) keep(triple);
    }
  }

  // The constraint triples themselves, so the client can resolve the same roots.
  // Positive forms ship their matching triples; negations ship NOTHING — a
  // surviving root has no readable matching triple by definition, and either-
  // branches recurse. (Removals that flip a negation arrive as deltas, §6.4.)
  const shipConstraint = (constraint: Constraint): void => {
    if ("either" in constraint) {
      for (const branch of constraint.either) for (const entry of branch) shipConstraint(entry);
      return;
    }
    if (isCorrelated(constraint)) throw new Error("Correlated constraint outside a subquery.");
    if ("not" in constraint || "absent" in constraint) return;
    for (const triple of matchAll(store, roots, constraint.predicate)) {
      if (tripleMatches(constraint, triple) && canRead(triple)) keep(triple);
    }
  };
  for (const constraint of payload.constraints) shipConstraint(constraint);
  // §6.2 — an every-instance seed ships each root's seed triple too, so the
  // client finds the same roots in its own cache.
  for (const predicate of payload.all ?? []) {
    for (const triple of matchAll(store, roots, predicate)) {
      if (canRead(triple)) keep(triple);
    }
  }

  // §6.8 — correlated subqueries: walk the ref path to the attachment subjects
  // (the roots themselves when there is none), then recurse once per (subject,
  // subquery) with the correlation bound to it. Each recursion collects
  // everything its rows need — including the constraint triples that let the
  // client resolve the same rows — filtered by the same policy as everything
  // else. Windowed parents keep the recursion count small.
  const batchedLevels: { subjects: Id[]; selection: RuntimeSelection }[] = [];
  for (const subquery of payload.subqueries ?? []) {
    let attach: Id[] = roots;
    for (const predicate of subquery.path ?? []) {
      const next = new Set<Id>();
      for (const triple of matchAll(store, attach, predicate)) {
        if (canRead(triple) && isRef(triple[2])) next.add(triple[2].id);
      }
      attach = [...next];
    }

    // §11.4 — the CORRELATE-ONLY shape (one parent-bound constraint, no window,
    // nothing nested) shares ONE batched walk across every parent: gather all
    // sources through the POS index, keep their ref triples, and let the level
    // walk below fetch their selections together instead of once per parent.
    const sole = subquery.payload.constraints[0];
    const batchable =
      subquery.payload.constraints.length === 1 &&
      sole !== undefined &&
      isCorrelated(sole) &&
      subquery.payload.subject === undefined &&
      subquery.payload.order === undefined &&
      subquery.payload.limit === undefined &&
      (subquery.payload.subqueries ?? []).length === 0;
    if (batchable) {
      const sources = new Set<Id>();
      for (const parent of attach) {
        for (const triple of store.match([undefined, sole.predicate, { id: parent }])) {
          if (!canRead(triple)) continue;
          keep(triple);
          sources.add(triple[0]);
        }
      }
      if (sources.size > 0) {
        batchedLevels.push({ subjects: [...sources], selection: subquery.payload.selection });
      }
      continue;
    }

    for (const subject of attach) {
      for (const triple of collectPayloadTriples(store, bindParent(subquery.payload, subject), canRead)) {
        keep(triple);
      }
    }
  }

  // Level-order walk: one batched read per (level, predicate) instead of one read
  // per subject per predicate — the N+1 fix (§11.4). Filtering still happens inside
  // the scan (SPEC §10.5), never on the results.
  let level: { subjects: Id[]; selection: RuntimeSelection }[] = [
    { subjects: roots, selection: payload.selection },
    ...batchedLevels,
  ];
  while (level.length > 0) {
    const next = new Map<RuntimeSelection, Set<Id>>();
    for (const { subjects, selection } of level) {
      canRead.preload?.(subjects);
      for (const [predicate, sub] of Object.entries(selection)) {
        const triples = matchAll(store, subjects, predicate).filter(canRead);
        for (const triple of triples) keep(triple);
        if (sub === true) continue;
        let bucket = next.get(sub);
        if (!bucket) next.set(sub, (bucket = new Set()));
        for (const [, , object] of triples) {
          if (isRef(object)) bucket.add(object.id);
        }
      }
    }
    level = [...next.entries()].map(([selection, subjects]) => ({
      subjects: [...subjects],
      selection,
    }));
  }

  return [...collected.values()];
}

/**
 * §6.6 — resolve THE WINDOW's roots, deferring policy when the adapter can rank.
 *
 * The general path filters every candidate through the policy and then windows —
 * O(candidates) policy checks. When one constraint, an order and a limit meet an
 * adapter with `topSubjects`, the order is applied to RAW candidates in the
 * storage engine and the policy checks only window-sized batches, walking the
 * cursor until the window fills. Invisible rows are skipped, never counted, so
 * §10.5 semantics are identical — the checks saved are the ones for rows the
 * window was never going to include.
 */
function windowedRoots(
  store: Readable,
  payload: QueryPayload,
  canRead: ReadFilter,
  negationEvidence?: NegationEvidence,
): Id[] {
  const { order, limit, constraints, all } = payload;
  const first = constraints[0];
  // Two seeds ride the fast path: ONE plain-value constraint, or NO constraint
  // with a single every-instance predicate (§6.2) — "the latest 50 todos".
  const seed: Pattern | undefined =
    constraints.length === 1 && first !== undefined && "value" in first
      ? [undefined, first.predicate, first.value]
      : constraints.length === 0 && all !== undefined && all.length === 1
        ? [undefined, all[0]!, undefined]
        : undefined;
  if (
    payload.subject !== undefined || // a pinned subject needs no window machinery
    order === undefined ||
    limit === undefined ||
    seed === undefined ||
    store.topSubjects === undefined
  ) {
    return applyWindow(store, resolveRoots(store, payload, canRead, negationEvidence), payload, canRead);
  }

  // The seed triple per candidate — the §10.5 visibility gate of each root.
  const seedTriples = new Map(store.match(seed).map((triple) => [triple[0], triple] as const));
  const candidates = [...seedTriples.keys()];
  if (candidates.length <= limit * 4) {
    // Small sets: batching machinery costs more than it saves.
    canRead.preload?.(candidates);
    const visible = candidates.filter((id) => canRead(seedTriples.get(id)!));
    return applyWindow(store, visible, payload, canRead);
  }

  const take = Math.max(limit * 2, 64);
  let cursor = payload.after
    ? { key: encodeValue(payload.after.value === null ? "" : payload.after.value), id: payload.after.id }
    : undefined;
  const roots: Id[] = [];

  for (;;) {
    const batch = store.topSubjects(candidates, order.predicate, order.direction, take, cursor);
    if (batch.length === 0) break;
    canRead.preload?.(batch.map((t) => t[0]));
    for (const triple of batch) {
      if (roots.length >= limit) break;
      // Both gates of §10.5: the order value AND the seed triple must be
      // readable for the row to exist in this reader's world.
      if (canRead(triple) && canRead(seedTriples.get(triple[0])!)) {
        roots.push(triple[0]);
      }
    }
    if (roots.length >= limit || batch.length < take) break;
    const last = batch[batch.length - 1]!;
    cursor = { key: encodeValue(last[2]), id: last[0] };
  }

  if (roots.length >= limit) return roots;
  // Underfilled: rows without an order value (they sort last) or heavy hiding —
  // the general path settles it.
  return applyWindow(store, resolveRoots(store, payload, canRead, negationEvidence), payload, canRead);
}

/**
 * Find the subjects satisfying every constraint, applying them in the order given.
 *
 * The first uses the POS index to go straight from (predicate, value) to subjects.
 * Each later one is a direct SPO lookup per surviving subject — which is why putting
 * the selective constraint first is so much cheaper: fewer survivors carried forward.
 */
function resolveRoots(
  store: Readable,
  payload: QueryPayload,
  canRead: ReadFilter = VISIBLE,
  negationEvidence?: NegationEvidence,
): Id[] {
  const shipEvidence = (subjects: Id[], constraint: Constraint): void => {
    if (negationEvidence === undefined || subjects.length === 0) return;
    const predicates = new Set<string>();
    negationPredicates(constraint, predicates);
    for (const predicate of predicates) negationEvidence(subjects, predicate);
  };
  const { constraints } = payload;
  if (anyCorrelated(constraints)) {
    // Only reachable by a hand-built payload: toPayload binds these per root.
    throw new Error("Correlated constraint outside a subquery.");
  }

  // §6.7 — a pinned subject IS the root set (0 or 1), then constraints filter it.
  // The visibility gate: you may read at least one of its facts — an entity whose
  // every triple is hidden from you does not exist in your world (§0.3, §10.5).
  if (payload.subject !== undefined) {
    canRead.preload?.([payload.subject]);
    let subjects = store.match([payload.subject, undefined, undefined]).some(canRead)
      ? [payload.subject]
      : [];
    for (const constraint of constraints) {
      shipEvidence(subjects, constraint);
      subjects = subjects.filter((subject) => subjectPasses(store, canRead, subject, constraint));
    }
    return subjects;
  }

  // §6.2 — a positive first constraint seeds through the index. Otherwise (no
  // constraint at all, or a negation first) the roots are EVERY instance and
  // every constraint refines — you cannot scan for what is missing (§0.3), but
  // you can scan for everything and then subtract.
  const [first, ...rest] = constraints;
  let subjects: Id[];
  let refinements: readonly Constraint[];
  if (first !== undefined && (canSeed(first) || "either" in first)) {
    subjects = seedRoots(store, first, canRead, negationEvidence, payload.all);
    shipEvidence(subjects, first); // an either-seed may hold negations inside
    refinements = rest;
  } else {
    if (payload.all === undefined) {
      throw new Error("A query payload needs a positive constraint, a subject, or `all` (every instance).");
    }
    subjects = seedEveryInstance(store, payload.all, canRead);
    refinements = constraints;
  }

  for (const constraint of refinements) {
    shipEvidence(subjects, constraint);
    // Positive forms AND negations batch one read per constraint (§11.4); only
    // `whereEither` refinements evaluate per surviving subject — the seed has
    // already made that set small.
    if ("value" in constraint || "anyOf" in constraint || "range" in constraint) {
      const surviving = new Set<Id>();
      for (const triple of matchAll(store, subjects, constraint.predicate)) {
        if (tripleMatches(constraint, triple) && canRead(triple)) surviving.add(triple[0]);
      }
      subjects = subjects.filter((subject) => surviving.has(subject));
    } else if ("not" in constraint || "absent" in constraint) {
      const held = new Map<Id, string[]>();
      for (const triple of matchAll(store, subjects, constraint.predicate)) {
        if (!canRead(triple)) continue;
        const encoded = held.get(triple[0]) ?? [];
        encoded.push(encodeValue(triple[2]));
        held.set(triple[0], encoded);
      }
      const banned = "not" in constraint ? new Set(constraint.not.map(encodeValue)) : undefined;
      subjects = subjects.filter((subject) => {
        const values = held.get(subject) ?? [];
        return banned === undefined
          ? values.length === 0
          : !values.some((value) => banned.has(value));
      });
    } else {
      subjects = subjects.filter((subject) => subjectPasses(store, canRead, subject, constraint));
    }
  }

  return subjects;
}

/**
 * Roots a SEEDING constraint finds on its own. Value and set forms go straight
 * through the POS index; a range scans its predicate; `whereEither` unions each
 * branch's roots (each branch obeying the same seeding rule, recursively).
 * A constraint triple you may not see never makes its subject a root, so an
 * invisible entity is indistinguishable from one that does not exist (SPEC §0.3).
 */
function seedRoots(
  store: Readable,
  first: Constraint,
  canRead: ReadFilter,
  negationEvidence?: NegationEvidence,
  all?: readonly string[],
): Id[] {
  if ("either" in first) {
    const seen = new Set<Id>();
    const union: Id[] = [];
    for (const branch of first.either) {
      for (const subject of resolveRoots(
        store,
        { constraints: branch, selection: {}, ...(all !== undefined ? { all } : {}) },
        canRead,
        negationEvidence,
      )) {
        if (!seen.has(subject)) {
          seen.add(subject);
          union.push(subject);
        }
      }
    }
    return union;
  }
  if (isCorrelated(first) || "not" in first || "absent" in first) {
    throw new Error("seedRoots needs a seeding constraint — resolveRoots handles the rest.");
  }
  const matches =
    "value" in first
      ? store.match([undefined, first.predicate, first.value])
      : "anyOf" in first
        ? first.anyOf.flatMap((value) => store.match([undefined, first.predicate, value]))
        : store.matchRange
          ? store.matchRange(first.predicate, encodeRange(first.range))
          : store
              .match([undefined, first.predicate, undefined])
              .filter((triple) => inRange(encodeValue(triple[2]), first.range));
  canRead.preload?.(matches.map((t) => t[0]));
  const seen = new Set<Id>();
  const subjects: Id[] = [];
  for (const triple of matches) {
    if (!seen.has(triple[0]) && canRead(triple)) {
      seen.add(triple[0]);
      subjects.push(triple[0]);
    }
  }
  return subjects;
}

/**
 * §6.2 — every instance: every subject holding any of the entity's instance
 * predicates, through the POS index one predicate at a time. The same
 * visibility gate as any seed: a triple you may not read never makes its
 * subject a root (§10.5).
 */
function seedEveryInstance(store: Readable, all: readonly string[], canRead: ReadFilter): Id[] {
  const seen = new Set<Id>();
  const subjects: Id[] = [];
  for (const predicate of all) {
    const matches = store.match([undefined, predicate, undefined]);
    canRead.preload?.(matches.map((triple) => triple[0]));
    for (const triple of matches) {
      if (!seen.has(triple[0]) && canRead(triple)) {
        seen.add(triple[0]);
        subjects.push(triple[0]);
      }
    }
  }
  return subjects;
}

/** §6.9/§6.10 — evaluate ONE constraint against ONE subject, refs to §10.5 intact. */
function subjectPasses(
  store: Readable,
  canRead: ReadFilter,
  subject: Id,
  constraint: Constraint,
): boolean {
  if ("either" in constraint) {
    return constraint.either.some((branch) =>
      branch.every((entry) => subjectPasses(store, canRead, subject, entry)),
    );
  }
  if (isCorrelated(constraint)) throw new Error("Correlated constraint outside a subquery.");
  const triples = store.match([subject, constraint.predicate, undefined]).filter(canRead);
  if ("absent" in constraint) return triples.length === 0;
  if ("not" in constraint) {
    const banned = new Set(constraint.not.map(encodeValue));
    return !triples.some((triple) => banned.has(encodeValue(triple[2])));
  }
  return triples.some((triple) => tripleMatches(constraint, triple));
}

/** Does this triple's object satisfy a positive (value/anyOf/range) constraint? */
function tripleMatches(
  constraint:
    | { predicate: string; value: Value }
    | { predicate: string; anyOf: readonly Value[] }
    | { predicate: string; range: { gt?: Value; gte?: Value; lt?: Value; lte?: Value } },
  triple: Triple,
): boolean {
  const encoded = encodeValue(triple[2]);
  if ("range" in constraint) return inRange(encoded, constraint.range);
  if ("anyOf" in constraint) return constraint.anyOf.some((value) => encodeValue(value) === encoded);
  return encoded === encodeValue(constraint.value);
}

/** §6.9 — a range's bounds, encoded, for the adapter fast path (`matchRange`). */
function encodeRange(range: { gt?: Value; gte?: Value; lt?: Value; lte?: Value }): {
  gt?: string;
  gte?: string;
  lt?: string;
  lte?: string;
} {
  return {
    ...(range.gt !== undefined ? { gt: encodeValue(range.gt) } : {}),
    ...(range.gte !== undefined ? { gte: encodeValue(range.gte) } : {}),
    ...(range.lt !== undefined ? { lt: encodeValue(range.lt) } : {}),
    ...(range.lte !== undefined ? { lte: encodeValue(range.lte) } : {}),
  };
}

/** §6.9 — ranges compare ENCODED values: the encoding is order-preserving (§6.6). */
function inRange(
  encoded: string,
  range: { gt?: Value; gte?: Value; lt?: Value; lte?: Value },
): boolean {
  if (range.gt !== undefined && !(encoded > encodeValue(range.gt))) return false;
  if (range.gte !== undefined && !(encoded >= encodeValue(range.gte))) return false;
  if (range.lt !== undefined && !(encoded < encodeValue(range.lt))) return false;
  if (range.lte !== undefined && !(encoded <= encodeValue(range.lte))) return false;
  return true;
}



/**
 * Materialize ONE subject through a (namespaced) selection — shared by query
 * results and policy contexts (§10.2), so both have the same shape by construction.
 *
 * The schema decides array vs scalar (§4.1), not the data — a `multiple` predicate
 * always yields an array, empty rather than undefined when the subject has no such
 * triple, so the shape never shifts with the contents of the store.
 */
export function materializeEntity(
  store: Readable,
  schema: Schema,
  subject: Id,
  selection: RuntimeSelection,
): Record<string, unknown> {
  return materialize(store, schema, subject, selection);
}

function materialize(
  store: Readable,
  schema: Schema,
  subject: Id,
  selection: RuntimeSelection,
): Record<string, unknown> {
  const entity: Record<string, unknown> = { id: subject };

  for (const [predicate, sub] of Object.entries(selection)) {
    const field = fieldOf(schema, predicate);
    const values = store.match([subject, predicate, undefined]).map((t) => t[2]);
    const key = resultKey(predicate);

    if (sub === true) {
      entity[key] = field.multiple ? values : values[0];
      continue;
    }

    const nested = values
      .filter(isRef)
      .map((ref) => materialize(store, schema, ref.id, sub));
    entity[key] = field.multiple ? nested : nested[0];
  }

  return entity;
}

/**
 * `"todo/text"` → `"text"`. Result keys are bare field names; within one entity
 * they are unique by construction, so no collision guard is needed (§6.5).
 */
export function resultKey(predicate: string): string {
  const slash = predicate.indexOf("/");
  return slash === -1 ? predicate : predicate.slice(slash + 1);
}
