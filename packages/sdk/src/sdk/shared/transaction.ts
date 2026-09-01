/**
 * SPEC §9 — the write API: DRAFTS.
 *
 * One way to write: inside `transact`, address a record and mutate a draft of it.
 * Property writes become intent operations (the Immer idiom — mutate a scoped
 * draft, changes are extracted); nothing else changes underneath: ops travel,
 * the server compiles them against truth, the optimistic delta previews locally.
 *
 *   await client.transact((tx) => {
 *     tx.edit(Todo, todoId).completed = true;    // set intent
 *     const fresh = tx.create(Todo, {            // typed: required fields REQUIRED
 *       text: "ship it", completed: false, owner: { id: me },
 *     });
 *     fresh.tags.push("urgent");                 // add intent
 *     fresh.tags.remove("q3");                   // remove intent
 *     tx.delete(oldId);
 *   });
 *
 * `edit` addresses a KNOWN id (existing, or fixed-id creation — the server
 * derives the verb from existence, §10.4); `create` mints a fresh id and takes
 * one typed object whose REQUIRED fields the compiler enforces — a §4.5
 * rejection moved to a compile error. Arrays are mutated (`push`/`remove`),
 * never reassigned: reassignment cannot map to add/remove intent honestly.
 *
 * Underneath sits SPEC §0.2: there is no "update" in a triple store, only
 * remove+add. Changing a value means emitting BOTH halves:
 *
 *   - ("user_1", "user/name", "Bob")
 *   + ("user_1", "user/name", "Christian")
 *
 * ...which is why a write has to read the current value first, and why a
 * Transaction takes a reader.
 */

import {
  entityName,
  fieldOf,
  predicateOf,
  subjectEntityName,
  validateValue,
  type EntityDef,
  type FieldBuilder,
  type FieldType,
  type Schema,
} from "./schema.ts";
import type { ValueOfField } from "./query.ts";
import type { Operation } from "./protocol.ts";
import { withDelta } from "./store.ts";
import type { Delta, Id, Readable, Triple, Value } from "./types.ts";
import { tripleKey } from "./value.ts";

type RequiredSingleKeys<F> = {
  [K in keyof F]: F[K] extends FieldBuilder<FieldType, false, false, unknown> ? K : never;
}[keyof F];

type OptionalSingleKeys<F> = {
  [K in keyof F]: F[K] extends FieldBuilder<FieldType, false, true, unknown> ? K : never;
}[keyof F];

type MultiFieldKeys<F> = {
  [K in keyof F]: F[K] extends FieldBuilder<FieldType, true, boolean, unknown>
    ? K
    : never;
}[keyof F];

/**
 * A writable record view. Typing mirrors query results (§4.5: types never lie):
 * required singles are `T` (assigning undefined is a compile error), optional
 * singles are `T | undefined` (assigning undefined CLEARS the field), multiples
 * are lists you mutate — `push`/`remove` — never reassign.
 */
export type Draft<E extends EntityDef> = { readonly id: Id } & {
  [K in RequiredSingleKeys<E>]: ValueOfField<E[K]>;
} & {
  [K in OptionalSingleKeys<E>]: ValueOfField<E[K]> | undefined;
} & {
  readonly [K in MultiFieldKeys<E>]: DraftList<ValueOfField<E[K]>>;
};

/** A multi-valued field on a draft: read like an array, change by intent. */
export type DraftList<T> = ReadonlyArray<T> & {
  push(...values: T[]): void;
  remove(value: T): void;
};

/**
 * What `create` takes: one typed object. Required single fields are REQUIRED —
 * forgetting one is a compile error, not a §4.5 server rejection.
 */
export type CreateValues<E extends EntityDef> = {
  [K in RequiredSingleKeys<E>]: ValueOfField<E[K]>;
} & {
  [K in OptionalSingleKeys<E>]?: ValueOfField<E[K]>;
} & {
  [K in MultiFieldKeys<E>]?: readonly ValueOfField<E[K]>[];
};

export class Transaction {
  // Keyed by tripleKey so the same triple can't be added or removed twice.
  // Maps preserve insertion order, so the resulting delta is deterministic.
  readonly #added = new Map<string, Triple>();
  readonly #removed = new Map<string, Triple>();
  /** What travels: intent, in order (§9.1). The delta above is only the optimistic preview. */
  readonly #operations: Operation[] = [];

  constructor(
    private readonly schema: Schema,
    private readonly reader: Readable,
  ) {}

  /**
   * A writable draft of ONE record, by id — existing, or a fixed-id creation
   * (the server derives the verb from existence, §10.4). Property writes record
   * intent; property reads return the current LOCAL value, so a draft can be
   * read mid-transaction (`if (todo.completed) …`).
   */
  edit<E extends EntityDef>(entity: E, subject: Id): Draft<E> {
    assertSubjectEntity(subject, entityName(entity));
    const lists = new Map<string, DraftList<Value>>();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const tx = this;
    return new Proxy({} as Draft<E>, {
      get(_target, field) {
        if (field === "id") return subject;
        if (typeof field !== "string") return undefined;
        const predicate = predicateOf(entity, field);
        if (fieldOf(tx.schema, predicate).multiple) {
          let list = lists.get(predicate);
          if (!list) lists.set(predicate, (list = tx.#draftList(subject, predicate)));
          return list;
        }
        return tx.#currentValues(subject, predicate)[0];
      },
      set(_target, field, value) {
        if (typeof field !== "string" || field === "id") {
          throw new Error(`Cannot assign "${String(field)}" on a draft.`);
        }
        const predicate = predicateOf(entity, field);
        if (fieldOf(tx.schema, predicate).multiple) {
          throw new Error(
            `"${predicate}" is a list — mutate it (push/remove), never reassign it.`,
          );
        }
        if (value === undefined) {
          if (!fieldOf(tx.schema, predicate).optional) {
            throw new Error(`"${predicate}" is required — it cannot be cleared.`);
          }
          tx.#recordClear(subject, predicate);
        } else {
          tx.#recordSet(subject, predicate, value as Value);
        }
        return true;
      },
    });
  }

  /**
   * Mint a record: a fresh id (client-side, §8.4) and one typed object whose
   * REQUIRED fields the compiler enforces. Returns a draft for further edits.
   */
  create<E extends EntityDef>(entity: E, values: CreateValues<E>): Draft<E> {
    const subject = newId(entityName(entity));
    const draft = this.edit(entity, subject);
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const predicate = predicateOf(entity, field);
      if (fieldOf(this.schema, predicate).multiple) {
        for (const entry of value as Value[]) this.#recordAdd(subject, predicate, entry);
      } else {
        this.#recordSet(subject, predicate, value as Value);
      }
    }
    return draft;
  }

  /** The live local values of (subject, predicate): storage + this tx's edits. */
  #currentValues(subject: Id, predicate: string): Value[] {
    const values: Value[] = [];
    for (const [, [s, p, o]] of this.#removedThenAddedView(subject, predicate)) {
      void s; void p;
      values.push(o);
    }
    return values;
  }

  /** Reader view for one (subject, predicate) honoring in-tx adds/removes. */
  *#removedThenAddedView(subject: Id, predicate: string): Iterable<[string, Triple]> {
    for (const triple of this.reader.match([subject, predicate, undefined])) {
      const key = tripleKey(triple);
      if (!this.#removed.has(key)) yield [key, triple];
    }
    for (const [key, triple] of this.#added) {
      if (triple[0] === subject && triple[1] === predicate) yield [key, triple];
    }
  }

  /** REPLACE intent: the §0.2 remove-half comes from the local view; the server
   * re-derives it authoritatively (§9.1). */
  #recordSet(subject: Id, predicate: string, value: Value): void {
    validateValue(fieldOf(this.schema, predicate), value, predicate);
    this.#operations.push({ op: "set", subject, predicate, value });
    for (const [key, triple] of this.#added) {
      if (triple[0] === subject && triple[1] === predicate) this.#added.delete(key);
    }
    for (const existing of this.reader.match([subject, predicate, undefined])) {
      this.#pushRemove(existing);
    }
    this.#pushAdd([subject, predicate, value]);
  }

  #recordAdd(subject: Id, predicate: string, value: Value): void {
    validateValue(fieldOf(this.schema, predicate), value, predicate);
    this.#operations.push({ op: "add", subject, predicate, value });
    this.#pushAdd([subject, predicate, value]);
  }

  #recordRemove(subject: Id, predicate: string, value: Value): void {
    this.#operations.push({ op: "remove", subject, predicate, value });
    this.#pushRemove([subject, predicate, value]);
  }

  /** `draft.optionalField = undefined` — remove every current value. */
  #recordClear(subject: Id, predicate: string): void {
    for (const value of this.#currentValues(subject, predicate)) {
      this.#recordRemove(subject, predicate, value);
    }
  }

  /** A multi-valued field as a mutable-by-intent list. */
  #draftList(subject: Id, predicate: string): DraftList<Value> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const tx = this;
    const base: unknown[] = [];
    const list = Object.assign(base, {
      push(...values: Value[]): void {
        for (const value of values) tx.#recordAdd(subject, predicate, value);
      },
      remove(value: Value): void {
        tx.#recordRemove(subject, predicate, value);
      },
    });
    return new Proxy(list as unknown as DraftList<Value>, {
      get(target, property) {
        if (property === "push" || property === "remove") {
          return (target as unknown as Record<string, unknown>)[property as string];
        }
        // Reads see LIVE local values — storage plus this tx's edits.
        const values = tx.#currentValues(subject, predicate);
        if (property === "length") return values.length;
        if (typeof property === "string" && /^\d+$/.test(property)) {
          return values[Number(property)];
        }
        const method = (values as unknown as Record<string | symbol, unknown>)[property];
        return typeof method === "function" ? (method as Function).bind(values) : method;
      },
    });
  }

  /**
   * Remove an entity entirely: every triple where it is the subject, and every
   * triple where something points AT it (or we'd leave dangling refs).
   *
   * The inbound sweep is SCHEMA-DRIVEN (§4.7): only ref-typed predicates can
   * point here, each answered by one POS lookup — the old full-store walk (and
   * the OPS-index wish that came with it) is gone.
   */
  delete(subject: Id): this {
    this.#operations.push({ op: "delete", subject });
    for (const triple of this.reader.match([subject, undefined, undefined])) {
      this.#pushRemove(triple);
    }
    // Inbound refs, SCHEMA-DRIVEN (§4.7): only ref-typed predicates can point
    // here, and each is one POS lookup — the old full-store walk is gone, and an
    // object VALUE that merely contains an id can never be swept as a ref.
    for (const predicate of refPredicates(this.schema)) {
      for (const triple of this.reader.match([undefined, predicate, { id: subject }])) {
        this.#pushRemove(triple);
      }
    }
    return this;
  }

  /**
   * Two artifacts of one transaction (§9.1): `operations` — the INTENT, which is
   * what travels to the server — and `delta`, this client's optimistic preview of
   * it, compiled against its own (partial) cache for the pending layer.
   */
  build(): { operations: Operation[]; delta: Delta } {
    return {
      operations: [...this.#operations],
      delta: {
        added: [...this.#added.values()],
        removed: [...this.#removed.values()],
      },
    };
  }

  #pushAdd(triple: Triple): this {
    this.#added.set(tripleKey(triple), triple);
    return this;
  }

  #pushRemove(triple: Triple): this {
    this.#removed.set(tripleKey(triple), triple);
    return this;
  }
}

/**
 * SPEC §8.4 — client-minted ids.
 *
 * Generated locally so an optimistic create needs no server round trip, and no id
 * reconciliation afterwards: the id the client chose IS the id the server stores.
 */
/** The predicates that can hold refs — the only ones a delete must sweep. */
function refPredicates(schema: Schema): string[] {
  return Object.keys(schema).filter((predicate) => {
    const type = schema[predicate]!.type;
    return type === "ref" || (Array.isArray(type) && type.includes("ref"));
  });
}

export function newId(prefix: string): Id {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

/** §4.6 — the id prefix declares the entity; a mismatched write is a bug, caught eagerly. */
export function assertSubjectEntity(subject: Id, entityName: string): void {
  if (subjectEntityName(subject) !== entityName) {
    throw new Error(
      `Subject "${subject}" is a ${subjectEntityName(subject)} — it cannot hold ${entityName} fields.`,
    );
  }
}

/**
 * SPEC §9.1 — the server compiles intent against the truth.
 *
 * Operations are applied IN ORDER against an evolving view of the store, so a later
 * op sees an earlier one's effect (two sets of one field settle on the last):
 *
 *   set      remove every current value of the field, add the new one — the client's
 *            partial cache never decides what gets removed
 *   add      append (multi-valued only)
 *   remove   drop one specific value
 *   delete   remove EVERY triple of the subject plus every inbound ref — including
 *            the ones the client never synced (this closes the old §11.3 gap)
 *
 * Add/remove of the same triple cancel, so the resulting delta is minimal. Returns
 * the delta for the log plus the explicitly deleted subjects for the policy's verb
 * derivation (§10.4).
 */
export function compileOperations(
  store: Readable,
  schema: Schema,
  operations: Operation[],
): { delta: Delta; deleted: Set<Id> } {
  const added = new Map<string, Triple>();
  const removed = new Map<string, Triple>();
  const deleted = new Set<Id>();

  const pushAdd = (triple: Triple) => {
    const key = tripleKey(triple);
    if (removed.has(key)) removed.delete(key);
    else added.set(key, triple);
  };
  const pushRemove = (triple: Triple) => {
    const key = tripleKey(triple);
    if (added.has(key)) added.delete(key);
    else removed.set(key, triple);
  };
  const view = (): Readable =>
    withDelta(store, { added: [...added.values()], removed: [...removed.values()] });

  const entityNames = new Set(
    Object.keys(schema).map((predicate) => predicate.slice(0, predicate.indexOf("/"))),
  );

  for (const operation of operations) {
    if (operation.op === "delete") {
      if (!entityNames.has(subjectEntityName(operation.subject))) {
        throw new Error(`Cannot delete "${operation.subject}": unknown entity.`);
      }
      const current = view();
      for (const triple of current.match([operation.subject, undefined, undefined])) {
        pushRemove(triple);
      }
      // Schema-driven inbound-ref sweep (§4.7): one POS lookup per ref predicate.
      for (const predicate of refPredicates(schema)) {
        for (const triple of current.match([undefined, predicate, { id: operation.subject }])) {
          pushRemove(triple);
        }
      }
      deleted.add(operation.subject);
      continue;
    }

    const { subject, predicate, value } = operation;
    const field = fieldOf(schema, predicate);
    validateValue(field, value, predicate);
    const entityName = predicate.slice(0, predicate.indexOf("/"));
    if (subjectEntityName(subject) !== entityName) {
      throw new Error(
        `Subject "${subject}" is a ${subjectEntityName(subject)} — it cannot hold ${entityName} fields.`,
      );
    }

    if (operation.op === "set") {
      if (field.multiple) {
        throw new Error(`"${predicate}" is multiple — use .add() to append, not .set().`);
      }
      for (const triple of view().match([subject, predicate, undefined])) {
        pushRemove(triple);
      }
      pushAdd([subject, predicate, value]);
    } else if (operation.op === "add") {
      if (!field.multiple) {
        throw new Error(`"${predicate}" is not multiple — use .set() to replace, not .add().`);
      }
      pushAdd([subject, predicate, value]);
    } else {
      pushRemove([subject, predicate, value]);
    }
  }

  return {
    delta: { added: [...added.values()], removed: [...removed.values()] },
    deleted,
  };
}
