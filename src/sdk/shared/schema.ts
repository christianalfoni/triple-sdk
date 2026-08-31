/**
 * SPEC §4 — Schema.
 *
 * Entities, not bare predicates. An entity is JUST its fields — a plain object —
 * and its name is the key it is registered under in `Schema.build`, stated exactly
 * once. The namespaced predicate (`todo/text`) is GENERATED for the triple layer,
 * which is unchanged underneath (§1–§3).
 *
 *   const User = Schema.from({ name: Schema.string() });
 *   const Team = Schema.from({ member: Schema.ref(User).multiple() });
 *   const Todo = Schema.from({
 *     text: Schema.string(),
 *     owner: Schema.ref(User),      // a ref KNOWS its target entity
 *     team: Schema.ref(Team),
 *   });
 *   const schema = Schema.build({ user: User, team: Team, todo: Todo });
 *
 * `from` defines ONE unit, `build` assembles them — the same pairing the policy
 * side uses (`Policy.from` / `Policy.build`, §10). `Schema.build` STAMPS each
 * entity with its key (a hidden symbol property), which is how `Query.from(Todo)`
 * and `tx.set(Todo, …)` know the predicate namespace without being handed the
 * registry — see `entityName`.
 *
 * `Schema.ref(User)` carries the target in the type, which is what lets query
 * selections and policy contexts nest with bare keys (§6.5) — nesting into `team`
 * knows it lands on Team.
 *
 * Mutual references use the thunk form — `Schema.ref(() => B)` — resolved
 * lazily, with interface annotations breaking the TYPE cycle (§4.4).
 */

import type { Id } from "./types.ts";

export type FieldType = "string" | "number" | "boolean" | "ref";

/**
 * What the triple layer sees for one predicate: just enough to decide replace vs
 * append (§4.1). The entity structure above it is a schema-level veneer.
 */
export type Field = {
  /** A single type, or the members of a `Schema.union`. Type-level only at runtime. */
  type: FieldType | readonly FieldType[];

  /**
   * Can this (subject, predicate) pair hold more than one value?
   *
   * The store itself does not enforce this — nothing stops two triples sharing a
   * subject and predicate. It is read by `Transaction` (what a write emits), the
   * query executor (array vs scalar), and §9.1 (server-side replace):
   *
   *                     multiple: false          multiple: true
   *   Write (§9)        .set() — replaces        .add() — appends
   *   Read (§6.3)       value or undefined       array, empty if absent
   *   Conflict (§8.3)   last write wins          set union
   */
  multiple: boolean;

  /**
   * May this field be absent (SPEC §4.5)?
   *
   * Fields are REQUIRED by default: their result type claims presence (`string`,
   * not `string | undefined`), and the server enforces it — a write that would
   * leave a required field absent on a surviving subject is rejected. `.optional()`
   * opts a field out of both.
   *
   * Policy contexts ignore this and stay lenient (§10.2): a rule may be looking at
   * a pre-create state where nothing exists yet.
   */
  optional: boolean;
};

/** The flat, per-predicate view (`"todo/text" → Field`) the runtime layers consume. */
export type Schema = Record<string, Field>;

/**
 * One field, mid-construction. Immutable: `.multiple()` returns a NEW builder, so a
 * builder held in a variable can be reused without one call site changing another.
 *
 * `R` is the ref's target entity — `never` for scalars — and is what selection and
 * policy-context types recurse through.
 */
export class FieldBuilder<
  T extends FieldType,
  M extends boolean,
  O extends boolean,
  R = never,
> {
  /**
   * Type-level anchor for T, which `field.type` no longer carries exactly (a union
   * stores its members as an array). Without a structural anchor the parameter
   * would be phantom, and conditional types could not tell builders apart.
   */
  declare readonly valueKind?: T;

  constructor(
    readonly field: { type: FieldType | readonly FieldType[]; multiple: M; optional: O },
    /** The ref's target — possibly a THUNK for mutual references (§4.4). Read
     * through `refTarget`, never directly. */
    readonly target?: R | (() => R),
  ) {}

  /** This field may hold many values. Writes append instead of replacing. */
  multiple(): FieldBuilder<T, true, O, R> {
    return new FieldBuilder({ ...this.field, multiple: true }, this.target);
  }

  /**
   * This field may be absent: results type it `| undefined` and the server stops
   * enforcing its presence (§4.5). Meaningless on `.multiple()` fields — an empty
   * array already expresses absence.
   */
  optional(): FieldBuilder<T, M, true, R> {
    return new FieldBuilder({ ...this.field, optional: true }, this.target);
  }
}

export type AnyFieldBuilder = FieldBuilder<FieldType, boolean, boolean, unknown>;

/** The value types a union's members produce, e.g. `string | number`. */
type UnionOf<Members extends readonly AnyFieldBuilder[]> =
  Members[number] extends FieldBuilder<infer T, boolean, boolean, unknown>
    ? T
    : never;

/** One entity: just its fields. The NAME is the key in `Schema.build` (§4.6). */
export type EntityDef = Record<string, AnyFieldBuilder>;

/** The app's entity registry, e.g. `{ user: User, team: Team, todo: Todo }`. */
export type Entities = Record<string, EntityDef>;

/**
 * Where a stamped entity keeps its name. A symbol, and non-enumerable, so
 * iterating an entity still yields exactly its fields and nothing else.
 */
const ENTITY_NAME = Symbol("entityName");

/**
 * The name an entity was registered under. Everything downstream of the schema —
 * the query builder, transactions, policy assembly — resolves names through this,
 * so the object key in `Schema.build` is the ONLY place a name is ever written.
 */
export function entityName(entity: EntityDef): string {
  const name = (entity as { [ENTITY_NAME]?: string })[ENTITY_NAME];
  if (name === undefined) {
    throw new Error(
      "This entity has no name yet: names come from the key in Schema.build({ … }). " +
        "Register the entity there (in the module that defines it) before using it.",
    );
  }
  return name;
}

/** A ref's target entity, resolving the mutual-reference thunk form (§4.4). */
export function refTarget(builder: AnyFieldBuilder): EntityDef | undefined {
  const raw = builder.target;
  if (raw === undefined) return undefined;
  return typeof raw === "function" ? (raw as () => EntityDef)() : (raw as EntityDef);
}

/** `"text"` on Todo → `"todo/text"` — the wire predicate for one entity field. */
export function predicateOf(entity: EntityDef, field: string): string {
  return `${entityName(entity)}/${field}`;
}

/**
 * §4 — THE schema: the entity registry with its derived forms computed once.
 * Shared by both sides. Pure DATA — this module knows nothing about policies;
 * the server pairs rules with it via `Policy.build(schema, …)` (§10.1).
 */
export class AppSchema<Es extends Entities = Entities> {
  /** The flat predicate map (`"todo/text" → Field`) the runtime layers consume. */
  readonly flat: Schema;
  /** The schema generation (§7.3). */
  readonly hash: string;

  constructor(readonly entities: Es) {
    // The key IS the name: stamp it onto each entity so standalone call sites
    // (Query.from(Todo), tx.set(Todo, …)) can resolve predicates later.
    for (const [name, entity] of Object.entries(entities)) {
      const stamped = (entity as { [ENTITY_NAME]?: string })[ENTITY_NAME];
      if (stamped !== undefined && stamped !== name) {
        throw new Error(
          `This entity is already registered as "${stamped}" — it cannot also be "${name}".`,
        );
      }
      if (stamped === undefined) {
        Object.defineProperty(entity, ENTITY_NAME, { value: name });
      }
    }
    this.flat = flattenEntities(entities);
    this.hash = schemaHash(entities);
  }
}

export const Schema = {
  /**
   * Define ONE entity: `Schema.from({ text: Schema.string(), … })`. Runtime-wise
   * an entity IS its fields object — this returns it unchanged — but declaring
   * through `from` checks every value is a field builder AT THE DEFINITION, not
   * three files away where the registry assembles.
   */
  from<F extends EntityDef>(fields: F): F {
    for (const [field, builder] of Object.entries(fields)) {
      if (!(builder instanceof FieldBuilder)) {
        throw new Error(
          `Field "${field}" is not a field builder — use Schema.string(), Schema.ref(…), ….`,
        );
      }
    }
    return fields;
  },

  /** Assemble the app's schema: `Schema.build({ user: User, team: Team, todo: Todo })`. */
  build<Es extends Entities>(entities: Es): AppSchema<Es> {
    return new AppSchema(entities);
  },

  string: () =>
    new FieldBuilder<"string", false, false>({
      type: "string",
      multiple: false,
      optional: false,
    }),
  number: () =>
    new FieldBuilder<"number", false, false>({
      type: "number",
      multiple: false,
      optional: false,
    }),
  boolean: () =>
    new FieldBuilder<"boolean", false, false>({
      type: "boolean",
      multiple: false,
      optional: false,
    }),

  /**
   * A pointer to another entity. For MUTUAL references, pass a thunk —
   * `Schema.ref(() => B)` — resolved lazily at first use (which is always after
   * both consts exist). The one cost of a cycle: TypeScript cannot INFER
   * circular types, so each side of the cycle annotates its fields with an
   * interface (§4.4 shows the pattern; pinned in query.type-test.ts).
   */
  ref<E extends EntityDef>(target: E | (() => E)): FieldBuilder<"ref", false, false, E> {
    return new FieldBuilder({ type: "ref", multiple: false, optional: false }, target);
  },

  /**
   * A field holding any of several scalar types: `Schema.union(Schema.string(),
   * Schema.number())` → `string | number`. Values are self-describing at runtime,
   * so nothing below the type level changes.
   *
   * Chiefly the RETYPE migration tool (§4.5, README): widen to the union, backfill,
   * verify, narrow back — every reader is forced to handle both meanwhile. Refs and
   * already-multiple/optional members are excluded; chain those on the union itself.
   */
  union<
    const Members extends readonly FieldBuilder<
      Exclude<FieldType, "ref">,
      false,
      false
    >[],
  >(...members: Members): FieldBuilder<UnionOf<Members>, false, false> {
    const types = members.flatMap((member) =>
      Array.isArray(member.field.type) ? member.field.type : [member.field.type],
    ) as FieldType[];
    return new FieldBuilder({ type: types, multiple: false, optional: false });
  },
};

/**
 * Collapse entity definitions into the flat predicate map the store, transaction
 * and executor layers read. Those layers never see an entity.
 */
export function flattenEntities(entities: Entities): Schema {
  const flat: Schema = {};
  for (const [name, entity] of Object.entries(entities)) {
    for (const [field, builder] of Object.entries(entity)) {
      flat[`${name}/${field}`] = builder.field;
    }
  }
  return flat;
}

/**
 * SPEC §4.6 — a subject's entity is declared by its id prefix: `todo_…` is a todo.
 * `newId("todo")` produces conforming ids; every write is checked against it, so a
 * `note/*` triple can never land on a `user_*` subject and entity membership stops
 * being an accident of which predicates happen to be present.
 */
export function subjectEntityName(subject: Id): string {
  const i = subject.indexOf("_");
  return i === -1 ? subject : subject.slice(0, i);
}

/** Look a field up by predicate, or throw. An unknown predicate is a bug. */
export function fieldOf(schema: Schema, predicate: Id): Field {
  const field = schema[predicate];
  if (!field) {
    throw new Error(
      `Unknown predicate "${predicate}". Add it to an entity, or fix the typo.`,
    );
  }
  return field;
}

/**
 * A stable fingerprint of the schema's SHAPE (SPEC §7.3): entity names, field
 * names, types, cardinality, optionality, ref targets — order-independent. Client
 * and server each compute it from the code they are running; a mismatch means the
 * two sides are different generations and must not talk past each other.
 */
export function schemaHash(entities: Entities): string {
  const canonical = Object.entries(entities)
    .map(([entity, fields]) => ({
      name: entity,
      fields: Object.entries(fields)
        .map(([name, builder]) => ({
          name,
          type: builder.field.type,
          multiple: builder.field.multiple,
          optional: builder.field.optional,
          // Ref targets are named too — stamped by the AppSchema constructor
          // before this runs. An unregistered target throws a naming error here,
          // which is the eager failure we want.
          target: builder.field.type === "ref" ? entityName(refTarget(builder)!) : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // FNV-1a over the canonical JSON — cheap, deterministic, dependency-free.
  const text = JSON.stringify(canonical);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
