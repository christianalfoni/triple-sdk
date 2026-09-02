/**
 * SPEC §10 — Permissions.
 *
 * SERVER ONLY. This module must never be imported by client code: a policy usually
 * references data the client does not have, so a client-side evaluation would not
 * merely be untrusted, it would be wrong (SPEC §10.1). The shared schema module
 * carries shape; this module carries logic. That split is the trust boundary.
 *
 *   const Policy = definePolicy({ actor: User });   // rules run AS a User (§10.2)
 *
 *   export const todoPolicy = Policy.from(Todo, {
 *     fields: {
 *       owner: true,                 // depth 1 — field comparison
 *       team: { member: true },      // depth 2 — traversal along the ref
 *     },
 *     read:   (ctx) => ctx.fields.owner?.id === ctx.actor.id ||
 *                      (ctx.fields.shared === true && ctx.actor.role === "member"),
 *     create: (ctx) => ctx.fields.owner?.id === ctx.actor.id,  // fields = ONCE IT LANDS
 *     update: (ctx) => ctx.fields.owner?.id === ctx.actor.id,
 *     delete: (ctx) => ctx.fields.owner?.id === ctx.actor.id,
 *     overrides: { notes: { read: … } },            // per-field override (read only)
 *   })
 *
 *   const policy = Policy.build(schema, { user: userPolicy, team: teamPolicy, … })
 *   new TripleServer({ schema, policy })
 *   // coverage checked at build(): a missing entity's policy does not compile
 *
 * `ctx.actor` is the actor's OWN record — their id plus every field of the actor
 * entity, loaded from the unfiltered store once per actor — so "who is asking"
 * is data in the cell (a role mirrored from the identity provider, say), not
 * transport metadata.
 *
 * Rules attach to the ENTITY — one read rule and three write verbs — because that is
 * the granularity policies actually have; per-field `overrides` cover
 * the exception ("this field is more private than the rest"). Omitting an entity
 * from build(), or a verb from a rule, is a compile error: deny-by-default enforced
 * by the type system rather than by remembering (SPEC §10.5).
 */

import {
  materializeEntity,
  resultKey,
  type EntityResult,
  type EntitySelection,
  type QueryBuilder,
  type RuntimeSelection,
} from "../shared/query.ts";
import {
  entityName,
  predicateOf,
  refTarget,
  subjectEntityName,
  type AnyFieldBuilder,
  type AppSchema,
  type Entities,
  type EntityDef,
  type Schema,
} from "../shared/schema.ts";
import { withDelta } from "../shared/store.ts";
import type { Delta, Id, Readable, Triple, Value } from "../shared/types.ts";

// -----------------------------------------------------------------------------
// Ctx — what a rule sees
// -----------------------------------------------------------------------------

/**
 * §10.2 — the actor's own record: `id` (from the authenticated connection, §7.4,
 * never from the message) plus every field of the actor entity declared in
 * `definePolicy({ actor })`. Lenient like `fields`: an actor with no row yet
 * ("system", "anonymous") is `{ id }` alone, so `ctx.actor.role` reads
 * undefined — and undefined denies. Write rules POSITIVELY (`role === "member"`),
 * never by exclusion (`role !== "guest"` would admit the unknown).
 */
export type ActorRecord<A extends EntityDef> = { id: Id } & EntityResult<
  A,
  { [K in keyof A]: true },
  false
>;

export type ReadCtx<E extends EntityDef, C, A extends EntityDef = EntityDef> = {
  /** Who is asking — their id and their own record (see ActorRecord). */
  actor: ActorRecord<A>;
  subject: Id;
  /**
   * The policy's declared `fields`, materialized for this subject — same computed
   * type as a query result, bare keys, but LENIENT: every field is `| undefined`
   * regardless of §4.5, because a rule may be looking at a pre-create state where
   * nothing exists yet. Loaded from the UNFILTERED store: deciding whether you may
   * read `text` requires reading `owner`, and filtering that would be circular
   * (SPEC §10.3). Loaded once per (fields, subject) per evaluation.
   */
  fields: EntityResult<E, C, false>;
  /**
   * Escape hatch for what a fixed-depth selection cannot express (recursion,
   * unbounded traversal). Also unfiltered. Reads made here cannot be batched —
   * prefer declared `fields` (SPEC §10.2).
   */
  read(subject: Id, predicate: string): Value[];
};

/**
 * Each verb sees the state(s) in which the entity actually EXISTS (SPEC §10.4):
 *
 *   create   ctx.fields = the entity ONCE IT LANDS — there is no pre-state
 *   delete   ctx.fields = the entity as it is now — there is no post-state
 *   update   ctx.fields = as it is now, ctx.after = once the delta lands
 *
 * Only update carries both, and it needs both: checked against the pre-state
 * alone, the landing state cannot be validated (nothing stops giving a todo
 * away, or moving it into a team you are not in); against the post-state alone,
 * anyone may SEIZE an entity by writing themselves in as owner.
 */
export type UpdateCtx<E extends EntityDef, C, A extends EntityDef = EntityDef> = ReadCtx<E, C, A> & {
  /** The same fields, materialized against the store once this delta lands
   * (any depth, via an overlay). */
  after: EntityResult<E, C, false>;
};

/** The verb for one subject in a delta, derived from pre/post existence (§10.4). */
export type WriteVerb = "create" | "update" | "delete";

/**
 * What a rule returns. `undefined` counts as DENY, so optional chains read
 * naturally: `(ctx) => ctx.fields.team?.member.some(…)` needs no `?? false` —
 * only an explicit `true` grants.
 */
export type Verdict = boolean | undefined;

/** One entity's policy, with its fields type erased for storage. */
export type EntityPolicy = {
  entity: EntityDef;
  /**
   * The declared fields selection. As written in `Policy.from` it holds BARE
   * field keys — a standalone policy has no registry, so predicate names do not
   * exist yet. `assemblePolicies` replaces it with the namespaced form;
   * everything past assembly reads that.
   */
  fields: RuntimeSelection;
  read: (ctx: ReadCtx<EntityDef, unknown>) => Verdict;
  create: (ctx: ReadCtx<EntityDef, unknown>) => Verdict;
  update: (ctx: UpdateCtx<EntityDef, unknown>) => Verdict;
  delete: (ctx: ReadCtx<EntityDef, unknown>) => Verdict;
  overrides: Record<
    string,
    {
      read?: (ctx: ReadCtx<EntityDef, unknown>) => Verdict;
      /** §10.4 — REPLACES the entity's create/update rule for THIS field's
       * changes. Delete stays entity-level: removing the subject is not a
       * field-sized decision. */
      write?: (ctx: ReadCtx<EntityDef, unknown>) => Verdict;
    }
  >;
};

export type Policy = {
  /** The schema these rules were built FROM — the server verifies it got the same one. */
  app: AppSchema;
  schema: Schema;
  /** §10.2 — the entity actors are instances of, and the (all-fields) selection that loads their record. */
  actor: { entity: EntityDef; selection: RuntimeSelection };
  byEntity: Record<string, EntityPolicy>;
  /**
   * predicate → the ref paths that lead from a policy's root subject to the level
   * holding that predicate (SPEC §10.6). `team/member` under todo's declared
   * fields `{ team: { member: true } }` yields path `["todo/team"]`: from a changed
   * team/member triple, walk `todo/team` refs BACKWARDS to find the todos whose
   * visibility may have changed. Depth-1 predicates have the empty path — the
   * triple's own subject is the root.
   *
   * This map exists because the fields are DECLARED: the visibility dependency
   * graph is static. Reads made through the `ctx.read` escape hatch are invisible
   * to it (§11.1) — one more reason to prefer declared `fields`.
   */
  dependencies: Map<string, string[][]>;
};

/** A single entity's policy, carrying its EXACT entity type — `Policy.build`'s
 * coverage check pairs it with the registry key it belongs under. */
export type EntityPolicyFor<E extends EntityDef> = Omit<EntityPolicy, "entity"> & {
  entity: E;
};

/**
 * §10.2 — bind the rule vocabulary to the entity actors are instances of. Every
 * `ctx.actor` in every rule is typed from it:
 *
 *   const Policy = definePolicy({ actor: User });
 *   export const todoPolicy = Policy.from(Todo, { fields, read, … });
 *   export const policy = Policy.build(schema, { user: userPolicy, todo: todoPolicy });
 *
 * Declared ONCE, because it is a fact about the workspace, not about any one
 * entity's rules — which is also why it is a factory and not a parameter of
 * `from`: the types have to flow to every rule site from a single place.
 */
export function definePolicy<A extends EntityDef>(options: { actor: A }) {
  const actorEntity = options.actor;
  return {
    /**
     * One standalone policy per entity — no registry in sight here:
     *
     *   export const todoPolicy = Policy.from(Todo, { fields, read, … })
     *
     * Mirrors the schema side deliberately: `X.from` defines one unit, `X.build`
     * assembles them. Coverage is checked at `Policy.build(schema, { … })`, which
     * requires a key per entity — a missing policy is a missing property, named.
     * Fields inference happens here, one site per call, so a check reaching for a
     * field it did not declare is a compile error (pinned in policy.type-test.ts).
     */
    from<E extends EntityDef, const C extends EntitySelection<E> = {}>(
      entity: E,
      definition: {
        /** What the rules get to SEE of the subject — a selection, traversing refs (§10.2). */
        fields?: C;
        read: (ctx: ReadCtx<E, C, A>) => Verdict;
        /** Sees the entity AS IT WILL LAND — a create has no pre-state (§10.4). */
        create: (ctx: ReadCtx<E, C, A>) => Verdict;
        /** Sees both states — the only verb that has two (§10.4). */
        update: (ctx: UpdateCtx<E, C, A>) => Verdict;
        /** Sees the entity as it is now — a delete has no post-state (§10.4). */
        delete: (ctx: ReadCtx<E, C, A>) => Verdict;
        /** Per-field overrides — the field rule WINS for that field's triples:
         * `read` filters them, `write` replaces the entity's create/update rule
         * when they change (delete stays entity-level). */
        overrides?: {
          [K in keyof E]?: {
            read?: (ctx: ReadCtx<E, C, A>) => Verdict;
            write?: (ctx: ReadCtx<E, C, A>) => Verdict;
          };
        };
      },
    ): EntityPolicyFor<E> {
      return {
        entity,
        // Bare keys, deliberately: no registry here means no names yet — assembly
        // namespaces this (see EntityPolicy.fields).
        fields: (definition.fields ?? {}) as RuntimeSelection,
        read: definition.read as EntityPolicy["read"],
        create: definition.create as EntityPolicy["create"],
        update: definition.update as EntityPolicy["update"],
        delete: definition.delete as EntityPolicy["delete"],
        overrides: (definition.overrides ?? {}) as EntityPolicy["overrides"],
      } as EntityPolicyFor<E>;
    },

    /**
     * Assemble one policy per entity into the form the server evaluates, KEYED BY
     * the registry names. The key does the coverage check: every entity is a
     * required property, so omitting one is a plain missing-property error naming
     * the gap. `TripleServer` takes the result alongside the schema it came from.
     */
    build<Es extends Entities>(
      schema: AppSchema<Es>,
      policies: { [K in keyof Es]: EntityPolicyFor<Es[K]> },
    ): Policy {
      return assemblePolicies(schema, actorEntity, policies as Record<string, EntityPolicy>);
    },
  };
}

/** @internal — `Policy.build` without the generics: checks, then assembly. */
function assemblePolicies(
  app: AppSchema,
  actorEntity: EntityDef,
  policies: Record<string, EntityPolicy>,
): Policy {
  // The type pairs key → entity structurally; identity makes it exact. Two
  // entities with identical fields LOOK the same to the types — a policy in the
  // wrong slot is caught here instead, at startup.
  const byEntity: Record<string, EntityPolicy> = {};
  for (const [name, entityPolicy] of Object.entries(policies)) {
    if (app.entities[name] === undefined) {
      throw new Error(`There is no entity named "${name}" in this schema.`);
    }
    if (entityPolicy.entity !== app.entities[name]) {
      throw new Error(
        `The policy under "${name}" was built from a different entity — ` +
          `Policy.from(${entityName(entityPolicy.entity)}, …) belongs under that name.`,
      );
    }
    byEntity[name] = {
      ...entityPolicy,
      fields: namespaceFields(entityPolicy.entity, entityPolicy.fields),
    };
  }
  for (const name of Object.keys(app.entities)) {
    if (byEntity[name] === undefined) {
      throw new Error(`No policy for entity "${name}".`);
    }
  }

  const dependencies = new Map<string, string[][]>();
  const walk = (selection: RuntimeSelection, path: string[]): void => {
    for (const [predicate, sub] of Object.entries(selection)) {
      const paths = dependencies.get(predicate) ?? [];
      const known = paths.some(
        (p) => p.length === path.length && p.every((step, i) => step === path[i]),
      );
      if (!known) paths.push([...path]);
      dependencies.set(predicate, paths);
      if (sub !== true) walk(sub, [...path, predicate]);
    }
  };
  for (const entityPolicy of Object.values(byEntity)) walk(entityPolicy.fields, []);

  // The actor record is the actor entity's EVERY field: one subject read per
  // actor per evaluation, cached with the fields — cheap, and it makes "who is
  // asking" ordinary data (§10.2).
  const everyField = Object.fromEntries(Object.keys(actorEntity).map((field) => [field, true]));
  const actor = { entity: actorEntity, selection: namespaceFields(actorEntity, everyField) };

  const built = { app, schema: app.flat, actor, byEntity, dependencies };
  registerFieldPredicates(built.schema, built);
  return built;
}

/** Bare-keyed fields selection → namespaced RuntimeSelection, walking ref targets. */
function namespaceFields(
  entity: EntityDef,
  selection: Record<string, unknown>,
): RuntimeSelection {
  const out: RuntimeSelection = {};
  for (const [field, sub] of Object.entries(selection)) {
    const builder = entity[field] as AnyFieldBuilder | undefined;
    if (!builder) {
      throw new Error(`Entity "${entityName(entity)}" has no field "${field}".`);
    }
    out[predicateOf(entity, field)] =
      sub === true
        ? true
        : namespaceFields(
            refTarget(builder)!,
            sub as Record<string, unknown>,
          );
  }
  return out;
}

// -----------------------------------------------------------------------------
// Evaluation
// -----------------------------------------------------------------------------

/** `"todo/text"` → its entity's policy, via the namespace. */
function policyFor(policy: Policy, predicate: string): EntityPolicy | undefined {
  const slash = predicate.indexOf("/");
  if (slash === -1) return undefined;
  return policy.byEntity[predicate.slice(0, slash)];
}

function fieldName(predicate: string): string {
  return predicate.slice(predicate.indexOf("/") + 1);
}

/**
 * Build a per-triple read test for one actor.
 *
 * Loaded fields are cached by (fields selection, subject) for the lifetime of one
 * evaluation — nothing writes during a query, so fields loaded at the start are
 * still correct at the end, and are discarded with the response (SPEC §10.2). All
 * checks on one entity share that one load, so a query touching five fields of a
 * subject loads its policy fields once.
 */
export function createReadFilter(
  store: Readable,
  policy: Policy,
  actor: Id,
): (triple: Triple) => boolean {
  return createFilterFactory(store, policy)(actor);
}

/**
 * §10.6 / §11.4 — the shareable form. Loaded fields are AUTHOR-INDEPENDENT (they
 * are raw entity data; only the check's verdict depends on who is asking), so one
 * factory shares a single fields cache across every actor's filter. Fan-out
 * builds one factory per state (pre/post) instead of one cache per subscriber.
 */
export function createFilterFactory(
  store: Readable,
  policy: Policy,
): (actor: Id) => ((triple: Triple) => boolean) & { preload: (subjects: Id[]) => void } {
  const loadFields = fieldsLoader(store, policy.schema);
  const read = reader(store);

  return (actor: Id) => {
    const me = actorRecord(loadFields, policy, actor);
    const filter = ([subject, predicate]: Triple): boolean => {
      const entityPolicy = policyFor(policy, predicate);
      // An unknown predicate has no policy, so nobody may read it. Deny by default.
      if (!entityPolicy) return false;

      // The field override wins for that field's triples; the entity rule otherwise.
      const check =
        entityPolicy.overrides[fieldName(predicate)]?.read ?? entityPolicy.read;

      // Only an explicit `true` grants — undefined (an optional chain that hit
      // nothing) denies, like everything else.
      return (
        check({
          actor: me,
          subject,
          fields: loadFields(entityPolicy.fields, subject) as EntityResult<EntityDef, unknown, false>,
          read,
        }) === true
      );
    };
    // Bulk-load fields before a batch of checks — one read per declared predicate
    // instead of one per subject (§11.4). Nested levels stay lazy.
    filter.preload = (subjects: Id[]) => loadFields.preload(subjects);
    return filter;
  };
}

/**
 * Check a proposed change. Returns a rejection reason, or null.
 *
 * The unit is the SUBJECT, not the triple: the delta's triples are grouped per
 * subject, the verb is derived from existence before and after (§10.4) —
 *
 *   nothing before            → create
 *   nothing left after        → delete
 *   otherwise                 → update
 *
 * — and that entity's verb check runs ONCE per subject. All-or-nothing: a partially
 * applied transaction would leave the client's optimistic state unreconcilable.
 */
export function checkWrite(
  store: Readable,
  policy: Policy,
  actor: Id,
  delta: Delta,
  deleted: ReadonlySet<Id> = new Set(),
): string | null {
  const after = withDelta(store, delta);
  const loadBefore = fieldsLoader(store, policy.schema);
  const loadAfter = fieldsLoader(after, policy.schema);
  const read = reader(store);
  // Who is asking, as they are NOW — a write cannot promote its own author.
  const me = actorRecord(loadBefore, policy, actor);

  // Group the delta's triples by (subject, entity namespace). One subject normally
  // has one entity; tx.delete also touches OTHER subjects' inbound refs, which
  // correctly evaluate as updates on their own entities.
  const groups = new Map<
    string,
    { subject: Id; entityPolicy: EntityPolicy; predicates: Set<string> }
  >();
  for (const [subject, predicate] of [...delta.removed, ...delta.added]) {
    const entityPolicy = policyFor(policy, predicate);
    if (!entityPolicy) {
      return `No policy covers "${predicate}" — refusing to write it.`;
    }
    const key = `${subject}|${entityName(entityPolicy.entity)}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { subject, entityPolicy, predicates: new Set() }));
    group.predicates.add(predicate);
  }

  for (const { subject, entityPolicy, predicates } of groups.values()) {
    // The verb is no longer inferred from what remains (§9.1): deletes are stated.
    const verb: WriteVerb = deleted.has(subject)
      ? "delete"
      : store.match([subject, undefined, undefined]).length > 0
        ? "update"
        : "create";

    // Each verb gets the state(s) in which the entity exists: create the
    // landing state, delete the current one, update both (§10.4).
    const before = () =>
      loadBefore(entityPolicy.fields, subject) as EntityResult<EntityDef, unknown, false>;
    const landed = () =>
      loadAfter(entityPolicy.fields, subject) as EntityResult<EntityDef, unknown, false>;

    if (verb === "delete") {
      // Removing the subject is not a field-sized decision: entity rule only.
      if (entityPolicy.delete({ actor: me, subject, fields: before(), read }) !== true) {
        return `Not allowed to delete ${entityName(entityPolicy.entity)} ${subject}.`;
      }
      continue;
    }

    // §10.4 — create/update judge PER TOUCHED FIELD: a field's `write` override
    // REPLACES the entity rule for that field's changes; everything else shares
    // one entity-rule verdict, evaluated at most once.
    const ctx: UpdateCtx<EntityDef, unknown> =
      verb === "create"
        ? { actor: me, subject, fields: landed(), after: landed(), read }
        : { actor: me, subject, fields: before(), after: landed(), read };
    let entityVerdict: boolean | undefined;
    const entityAllows = (): boolean =>
      (entityVerdict ??=
        (verb === "create" ? entityPolicy.create(ctx) : entityPolicy.update(ctx)) === true);
    for (const predicate of predicates) {
      const override = entityPolicy.overrides[fieldName(predicate)]?.write;
      const allowed = override !== undefined ? override(ctx) === true : entityAllows();
      if (!allowed) {
        return override !== undefined
          ? `Not allowed to ${verb} ${predicate} on ${subject}.`
          : `Not allowed to ${verb} ${entityName(entityPolicy.entity)} ${subject}.`;
      }
    }
  }
  return null;
}

/** §10.2 — the actor's own record, through the same cached loader as `fields`. */
function actorRecord(
  loadFields: ReturnType<typeof fieldsLoader>,
  policy: Policy,
  actor: Id,
): ActorRecord<EntityDef> {
  return loadFields(policy.actor.selection, actor) as ActorRecord<EntityDef>;
}

function reader(store: Readable) {
  return (subject: Id, predicate: string): Value[] =>
    store.match([subject, predicate, undefined]).map((triple) => triple[2]);
}

/**
 * Cache key = (fields selection, subject) — exactly the two things that vary. The
 * VALUES vary by subject; WHICH fields are held varies by entity, via the fields
 * selection each entity policy carries.
 */
function fieldsLoader(store: Readable, schema: Schema) {
  const cache = new Map<object, Map<Id, Record<string, unknown>>>();
  // Depth-1 predicate values, bulk-loaded: subject → predicate → values.
  const preloaded = new Map<Id, Map<string, unknown[]>>();

  const loader = (selection: RuntimeSelection, subject: Id): Record<string, unknown> => {
    let bySubject = cache.get(selection);
    if (!bySubject) cache.set(selection, (bySubject = new Map()));

    let entity = bySubject.get(subject);
    if (!entity) {
      const bulk = preloaded.get(subject);
      if (bulk) {
        // Assemble depth-1 fields from the bulk load; recurse only into refs.
        entity = { id: subject } as Record<string, unknown>;
        for (const [predicate, sub] of Object.entries(selection)) {
          const field = schema[predicate];
          const values = bulk.get(predicate) ?? [];
          const key = resultKey(predicate);
          if (sub === true) {
            entity[key] = field?.multiple ? values : values[0];
          } else {
            const nested = values
              .filter((v): v is { id: Id } => typeof v === "object" && v !== null && "id" in v)
              .map((ref) => materializeEntity(store, schema, ref.id, sub));
            entity[key] = field?.multiple ? nested : nested[0];
          }
        }
      } else {
        entity = materializeEntity(store, schema, subject, selection);
      }
      bySubject.set(subject, entity);
    }
    return entity;
  };

  /** One batched read per declared predicate for every policy in play. */
  loader.preload = (subjects: Id[]) => {
    const fresh = subjects.filter((s) => !preloaded.has(s));
    if (fresh.length === 0 || !store.matchSubjects) return;
    const predicates = new Set<string>();
    for (const entry of fieldPredicateCache.get(schema) ?? []) predicates.add(entry);
    if (predicates.size === 0) return;
    for (const subject of fresh) preloaded.set(subject, new Map());
    for (const predicate of predicates) {
      for (const [subject, , value] of store.matchSubjects(fresh, predicate)) {
        const bucket = preloaded.get(subject)!;
        const list = (bucket.get(predicate) as unknown[] | undefined) ?? [];
        list.push(value);
        bucket.set(predicate, list);
      }
    }
    // Subjects whose predicates returned nothing keep their (empty) marker so we
    // do not re-query them.
  };

  return loader;
}

/** The depth-1 declared predicates per schema, registered at policy assembly. */
const fieldPredicateCache = new WeakMap<Schema, Set<string>>();

/** @internal — called by assemblePolicies so preload knows what to bulk-load. */
export function registerFieldPredicates(schema: Schema, policy: Policy): void {
  const predicates = new Set<string>();
  for (const entityPolicy of Object.values(policy.byEntity)) {
    for (const predicate of Object.keys(entityPolicy.fields)) predicates.add(predicate);
  }
  fieldPredicateCache.set(schema, predicates);
}

// Referenced only in doc positions; keeps the import graph honest.
export type { QueryBuilder };

/**
 * §13 — may this actor see this SUBJECT at all? Used to scope ephemeral messages
 * tied to an entity; runs the entity's default read rule against its fields.
 */
export function canSeeSubject(
  store: Readable,
  policy: Policy,
  actor: Id,
  subject: Id,
): boolean {
  const entityPolicy = policy.byEntity[subjectEntityName(subject)];
  if (!entityPolicy) return false;
  const loadFields = fieldsLoader(store, policy.schema);
  return (
    entityPolicy.read({
      actor: actorRecord(loadFields, policy, actor),
      subject,
      fields: loadFields(entityPolicy.fields, subject) as EntityResult<EntityDef, unknown, false>,
      read: (s2, p2) => store.match([s2, p2, undefined]).map((t) => t[2]),
    }) === true
  );
}
