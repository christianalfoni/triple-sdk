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
 * side uses (`Policy.from` / `Policy.build` under `definePolicy`, §10). `Schema.build` STAMPS each
 * entity with its key (a hidden symbol property), which is how `Query.from(Todo)`
 * and `tx.edit(Todo, …)` know the predicate namespace without being handed the
 * registry — see `entityName`.
 *
 * `Schema.ref(User)` carries the target in the type, which is what lets query
 * selections and policy contexts nest with bare keys (§6.5) — nesting into `team`
 * knows it lands on Team.
 *
 * Mutual references use the thunk form — `Schema.ref(() => B)` — resolved
 * lazily, with interface annotations breaking the TYPE cycle (§4.4).
 */

import type { Id, Value } from "./types.ts";

export type FieldType = "string" | "number" | "boolean" | "ref" | "object";

/**
 * §4.7 — the runtime shape of an object field's members, carried on the Field so
 * writes validate against it and the SCHEMA HASH sees it (a shape change is a
 * generation change — the migration machinery must notice). No `multiple`, no
 * refs: an object value has no identity and no triple cardinality inside.
 */
export type ObjectMemberField = {
  type: Exclude<FieldType, "ref"> | readonly Exclude<FieldType, "ref">[];
  optional: boolean;
  shape?: Record<string, ObjectMemberField>;
  /** `Schema.oneOf` members: the only strings allowed. */
  values?: readonly string[];
};

/**
 * What the triple layer sees for one predicate: just enough to decide replace vs
 * append (§4.1). The entity structure above it is a schema-level veneer.
 */
export type Field = {
  /** A single type, or the members of a `Schema.union`. */
  type: FieldType | readonly FieldType[];

  /** §4.7 — present exactly when `type` is "object": the members' shape. */
  shape?: Record<string, ObjectMemberField>;

  /**
   * §4.8 — a `Schema.oneOf("admin", "member")` field: a string whose only
   * legal values are these. Runtime data, like `shape`: writes validate against
   * it and the schema hash sees it, so adding a value is a generation change.
   */
  values?: readonly string[];

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
  L = unknown,
> {
  /**
   * Type-level anchor for T, which `field.type` no longer carries exactly (a union
   * stores its members as an array). Without a structural anchor the parameter
   * would be phantom, and conditional types could not tell builders apart.
   */
  declare readonly valueKind?: T;
  /** §4.8 — anchor for L, the literal union of a `Schema.oneOf`; `unknown` = no narrowing. */
  declare readonly literal?: L;

  constructor(
    readonly field: {
      type: FieldType | readonly FieldType[];
      multiple: M;
      optional: O;
      /** §4.7 — object fields carry their members' shape. */
      shape?: Record<string, ObjectMemberField>;
      /** §4.8 — oneOf fields carry their allowed values. */
      values?: readonly string[];
    },
    /** The ref's target — possibly a THUNK for mutual references (§4.4). Read
     * through `refTarget`, never directly. */
    readonly target?: R | (() => R),
  ) {}

  /** This field may hold many values. Writes append instead of replacing. */
  multiple(): FieldBuilder<T, true, O, R, L> {
    return new FieldBuilder({ ...this.field, multiple: true }, this.target);
  }

  /**
   * This field may be absent: results type it `| undefined` and the server stops
   * enforcing its presence (§4.5). Meaningless on `.multiple()` fields — an empty
   * array already expresses absence.
   */
  optional(): FieldBuilder<T, M, true, R, L> {
    return new FieldBuilder({ ...this.field, optional: true }, this.target);
  }
}

export type AnyFieldBuilder = FieldBuilder<FieldType, boolean, boolean, unknown>;

/** The value types a union's members produce, e.g. `string | number`. */
type UnionOf<Members extends readonly AnyFieldBuilder[]> =
  Members[number] extends FieldBuilder<infer T, boolean, boolean, unknown>
    ? T
    : never;

/** What may live INSIDE a `Schema.object`: single-valued non-ref builders. */
export type ObjectShape = Record<
  string,
  FieldBuilder<Exclude<FieldType, "ref">, false, boolean, unknown>
>;

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
    // (Query.from(Todo), tx.edit(Todo, …)) can resolve predicates later.
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
   * §4.8 — a string that may only be one of these values:
   * `Schema.oneOf("admin", "member", "appUser")` types as the literal union and
   * REJECTS anything else on write, both sides. The values are shape (they feed
   * the schema hash), so adding one is a generation change — which is what you
   * want when readers switch on the value.
   */
  oneOf<const V extends readonly [string, ...string[]]>(
    ...values: V
  ): FieldBuilder<"string", false, false, never, V[number]> {
    if (new Set(values).size !== values.length) {
      throw new Error(`Schema.oneOf: values must be distinct (${values.join(", ")}).`);
    }
    return new FieldBuilder({ type: "string", multiple: false, optional: false, values });
  },

  /**
   * §4.7 — a structured value WITHOUT identity: stored as ONE triple, replaced
   * whole on every change (which is exactly right when members change together —
   * `{ x, y }` can never tear under per-field merge). Members use the same
   * builders as fields — scalars, unions, `.optional()`, nested `Schema.object`
   * — but never refs (an object value cannot be pointed at, so it does not get
   * to point) and never `.multiple()` (no triples inside a value). The shape is
   * runtime data: writes validate against it, and it feeds the schema hash, so
   * reshaping an object is a schema generation change (§7.3).
   */
  object<const S extends ObjectShape>(shape: S): FieldBuilder<"object", false, false, S> {
    const members: Record<string, ObjectMemberField> = {};
    for (const [name, builder] of Object.entries(shape)) {
      if (!(builder instanceof FieldBuilder)) {
        throw new Error(`Object member "${name}" is not a field builder.`);
      }
      const type = builder.field.type;
      if (type === "ref" || (Array.isArray(type) && type.includes("ref"))) {
        throw new Error(`Object member "${name}" is a ref — object values have no identity (§4.7).`);
      }
      if (builder.field.multiple) {
        throw new Error(`Object member "${name}" is .multiple() — there are no triples inside a value (§4.7).`);
      }
      members[name] = {
        type: type as ObjectMemberField["type"],
        optional: builder.field.optional,
        ...(builder.field.shape !== undefined ? { shape: builder.field.shape } : {}),
        ...(builder.field.values !== undefined ? { values: builder.field.values } : {}),
      };
    }
    return new FieldBuilder(
      { type: "object", multiple: false, optional: false, shape: members },
      shape as never,
    );
  },

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

/**
 * §4.2 (now enforced) — validate ONE value against a field's declared type, on
 * every write path: the client's draft (early error) and the server's compile
 * (authoritative). Object values check recursively against the shape: required
 * members present, no unknown members, each member typed.
 */
export function validateValue(
  field: {
    type: FieldType | readonly FieldType[];
    shape?: Record<string, ObjectMemberField>;
    values?: readonly string[];
  },
  value: Value,
  where: string,
): void {
  const types = Array.isArray(field.type) ? field.type : [field.type];
  for (const type of types) {
    if (matchesType(type as FieldType, value, field.shape, field.values)) return;
  }
  throw new Error(
    `${where}: ${JSON.stringify(value)} is not a ${
      field.values ? `one of ${field.values.map((v) => JSON.stringify(v)).join(" | ")}` : types.join(" | ")
    }.`,
  );
}

function matchesType(
  type: FieldType,
  value: Value,
  shape: Record<string, ObjectMemberField> | undefined,
  values?: readonly string[],
): boolean {
  switch (type) {
    case "string":
      return typeof value === "string" && (values === undefined || values.includes(value));
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "ref":
      return (
        typeof value === "object" && value !== null &&
        typeof (value as { id?: unknown }).id === "string" &&
        Object.keys(value).length === 1
      );
    case "object": {
      if (typeof value !== "object" || value === null || shape === undefined) return false;
      const record = value as Record<string, Value>;
      for (const key of Object.keys(record)) {
        if (shape[key] === undefined) return false; // unknown member
      }
      for (const [member, memberField] of Object.entries(shape)) {
        const held = record[member];
        if (held === undefined) {
          if (!memberField.optional) return false; // missing required member
          continue;
        }
        const memberTypes = Array.isArray(memberField.type) ? memberField.type : [memberField.type];
        if (!memberTypes.some((t) => matchesType(t as FieldType, held, memberField.shape, memberField.values))) {
          return false;
        }
      }
      return true;
    }
  }
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
          shape: builder.field.shape ?? null,
          values: builder.field.values ?? null,
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

// -----------------------------------------------------------------------------
// §4.9 — Declarations: the schema as DATA
// -----------------------------------------------------------------------------

/**
 * One field, as data. The builders above are the typed form for code; this is
 * the same shape for a schema that arrives at runtime — declared by an agent
 * over a wire, stored in a cell, served to a browser. `entitiesFromDeclaration`
 * turns it into the very same builders, so everything downstream (validation,
 * the hash, queries, policies) is one mechanism.
 */
export type FieldDeclaration =
  | "string"
  | "number"
  | "boolean"
  | { type: "string" | "number" | "boolean"; multiple?: boolean; optional?: boolean }
  | { ref: string; multiple?: boolean; optional?: boolean }
  | { oneOf: readonly string[]; multiple?: boolean; optional?: boolean }
  | { object: Record<string, FieldDeclaration>; optional?: boolean };

export type EntityDeclaration = { fields: Record<string, FieldDeclaration> };

export type SchemaDeclaration = { entities: Record<string, EntityDeclaration> };

const ENTITY_NAME_RULE = /^[a-z][a-zA-Z0-9]*$/; // ids are `<name>_…`, so no underscores
const FIELD_NAME_RULE = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Build entities from a declaration. `base` are entities that already exist
 * (a workspace's fixed ones): declared refs may target them, and a declared
 * name may not shadow them. Returns ONLY the declared entities — spread them
 * next to `base` into `Schema.build`. Every problem is thrown with its path.
 */
export function entitiesFromDeclaration(
  declaration: SchemaDeclaration,
  base: Entities = {},
): Entities {
  if (typeof declaration !== "object" || declaration === null || typeof declaration.entities !== "object") {
    throw new Error('A schema declaration is { entities: { <name>: { fields: { … } } } }.');
  }
  const out: Entities = {};
  // Two passes: every entity object exists before any ref resolves, and refs
  // are thunks anyway (§4.4), so declared entities may point at each other.
  for (const name of Object.keys(declaration.entities)) {
    if (!ENTITY_NAME_RULE.test(name)) {
      throw new Error(`Entity "${name}": names are lowerCamelCase letters and digits (ids are "${name}_…").`);
    }
    if (base[name]) throw new Error(`Entity "${name}" already exists in this workspace and cannot be redeclared.`);
    out[name] = {};
  }
  const target = (ref: string, where: string): EntityDef => {
    const entity = out[ref] ?? base[ref];
    if (!entity) throw new Error(`${where}: there is no entity "${ref}" to reference.`);
    return entity;
  };
  for (const [name, entity] of Object.entries(declaration.entities)) {
    if (typeof entity !== "object" || entity === null || typeof entity.fields !== "object") {
      throw new Error(`Entity "${name}": expected { fields: { … } }.`);
    }
    for (const [field, spec] of Object.entries(entity.fields)) {
      const where = `${name}.${field}`;
      if (!FIELD_NAME_RULE.test(field) || field === "id") {
        throw new Error(`${where}: field names are lowerCamelCase; "id" is every row's own.`);
      }
      out[name]![field] = builderFromDeclaration(spec, where, target);
    }
  }
  return out;
}

function builderFromDeclaration(
  spec: FieldDeclaration,
  where: string,
  target: (ref: string, where: string) => EntityDef,
): AnyFieldBuilder {
  const scalar = (type: "string" | "number" | "boolean"): AnyFieldBuilder =>
    type === "string" ? Schema.string() : type === "number" ? Schema.number() : Schema.boolean();
  let builder: AnyFieldBuilder;
  let modifiers: { multiple?: boolean; optional?: boolean } = {};
  if (typeof spec === "string") {
    if (spec !== "string" && spec !== "number" && spec !== "boolean") {
      throw new Error(`${where}: "${spec}" is not a type — string, number, boolean, { ref }, { oneOf }, { object }.`);
    }
    builder = scalar(spec);
  } else if (typeof spec !== "object" || spec === null) {
    throw new Error(`${where}: a field is a type name or an object describing one.`);
  } else if ("ref" in spec) {
    const ref = spec.ref;
    if (typeof ref !== "string") throw new Error(`${where}: ref must name an entity.`);
    builder = Schema.ref(() => target(ref, where));
    modifiers = spec;
  } else if ("oneOf" in spec) {
    if (!Array.isArray(spec.oneOf) || spec.oneOf.length === 0 || !spec.oneOf.every((v) => typeof v === "string")) {
      throw new Error(`${where}: oneOf lists at least one string value.`);
    }
    builder = Schema.oneOf(...(spec.oneOf as [string, ...string[]]));
    modifiers = spec;
  } else if ("object" in spec) {
    const shape: ObjectShape = {};
    for (const [member, memberSpec] of Object.entries(spec.object)) {
      if (!FIELD_NAME_RULE.test(member)) throw new Error(`${where}.${member}: member names are lowerCamelCase.`);
      const built = builderFromDeclaration(memberSpec, `${where}.${member}`, target);
      if (built.field.type === "ref" || built.field.multiple) {
        throw new Error(`${where}.${member}: object members are single scalars — no refs, no lists (§4.7).`);
      }
      shape[member] = built as ObjectShape[string];
    }
    builder = Schema.object(shape);
    modifiers = { optional: spec.optional };
  } else if ("type" in spec) {
    if (spec.type !== "string" && spec.type !== "number" && spec.type !== "boolean") {
      throw new Error(`${where}: type must be string, number or boolean.`);
    }
    builder = scalar(spec.type);
    modifiers = spec;
  } else {
    throw new Error(`${where}: describe the field with type, ref, oneOf or object.`);
  }
  if (modifiers.multiple) builder = builder.multiple();
  if (modifiers.optional) builder = builder.optional();
  return builder;
}

/**
 * The declaration form of built entities — the inverse of
 * `entitiesFromDeclaration`, exact enough that rebuilding yields the same hash.
 * This is how a cell ships its whole schema (fixed entities included) to a
 * browser as data.
 */
export function declarationOf(entities: Entities): SchemaDeclaration {
  const out: SchemaDeclaration = { entities: {} };
  for (const [name, entity] of Object.entries(entities)) {
    const fields: Record<string, FieldDeclaration> = {};
    for (const [field, builder] of Object.entries(entity)) fields[field] = declarationOfField(builder);
    out.entities[name] = { fields };
  }
  return out;
}

function declarationOfField(builder: AnyFieldBuilder): FieldDeclaration {
  const { type, multiple, optional, values, shape } = builder.field;
  const modifiers = { ...(multiple ? { multiple: true } : {}), ...(optional ? { optional: true } : {}) };
  if (type === "ref") return { ref: entityName(refTarget(builder)!), ...modifiers };
  if (values) return { oneOf: [...values], ...modifiers };
  if (type === "object") {
    const object: Record<string, FieldDeclaration> = {};
    for (const [member, memberField] of Object.entries(shape ?? {})) {
      object[member] = declarationOfMember(memberField);
    }
    return { object, ...(optional ? { optional: true } : {}) };
  }
  if (Array.isArray(type)) throw new Error("A union field has no declaration form (retype through oneOf).");
  const scalar = type as "string" | "number" | "boolean";
  return Object.keys(modifiers).length === 0 ? scalar : { type: scalar, ...modifiers };
}

function declarationOfMember(member: ObjectMemberField): FieldDeclaration {
  const modifiers = member.optional ? { optional: true } : {};
  if (member.values) return { oneOf: [...member.values], ...modifiers };
  if (member.shape) {
    const object: Record<string, FieldDeclaration> = {};
    for (const [name, nested] of Object.entries(member.shape)) object[name] = declarationOfMember(nested);
    return { object, ...modifiers };
  }
  if (Array.isArray(member.type)) throw new Error("A union member has no declaration form.");
  const scalar = member.type as "string" | "number" | "boolean";
  return member.optional ? { type: scalar, optional: true } : scalar;
}
