/**
 * SPEC §9 — Entity API.
 *
 * This exists to solve SPEC §0.2: there is no "update" in a triple store, only add
 * and remove. Changing a value means emitting BOTH halves:
 *
 *   - ("user_1", "user/name", "Bob")
 *   + ("user_1", "user/name", "Christian")
 *
 * ...which means a write has to read the current value first. That is exactly what a
 * Transaction does, and why it needs a reader.
 */

import {
  entityName,
  fieldOf,
  predicateOf,
  subjectEntityName,
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

type SingleFieldKeys<F> = {
  [K in keyof F]: F[K] extends FieldBuilder<FieldType, false, boolean, unknown>
    ? K
    : never;
}[keyof F];

type MultiFieldKeys<F> = {
  [K in keyof F]: F[K] extends FieldBuilder<FieldType, true, boolean, unknown>
    ? K
    : never;
}[keyof F];

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
   * Write a single-valued field. REPLACES: removes whatever is there now.
   *
   * Entity-aware and typed: `field` must be one of the entity's `multiple: false`
   * fields, and `value` must match its declared type — using .set() on a multiple
   * field is a compile error before it is a runtime one.
   */
  set<E extends EntityDef, K extends SingleFieldKeys<E> & string>(
    entity: E,
    subject: Id,
    field: K,
    value: ValueOfField<E[K]>,
  ): this {
    assertSubjectEntity(subject, entityName(entity));
    const predicate = predicateOf(entity, field);
    this.#operations.push({ op: "set", subject, predicate, value: value as Value });
    if (fieldOf(this.schema, predicate).multiple) {
      throw new Error(
        `"${predicate}" is multiple — use .add() to append, not .set().`,
      );
    }

    // If this transaction already set this field, drop that earlier add. Without
    // this, set() twice in one transaction would emit two adds and the store — being
    // a set — would end up holding both values.
    for (const [key, triple] of this.#added) {
      if (triple[0] === subject && triple[1] === predicate) this.#added.delete(key);
    }

    // Remove the value currently in storage, if any. This is the half of the write
    // that §0.2 is about. The server re-derives it authoritatively (§9.1).
    for (const existing of this.reader.match([subject, predicate, undefined])) {
      this.#pushRemove(existing);
    }

    return this.#pushAdd([subject, predicate, value as Value]);
  }

  /** Write a multi-valued field. APPENDS: existing values stay. Typed like .set(). */
  add<E extends EntityDef, K extends MultiFieldKeys<E> & string>(
    entity: E,
    subject: Id,
    field: K,
    value: ValueOfField<E[K]>,
  ): this {
    assertSubjectEntity(subject, entityName(entity));
    const predicate = predicateOf(entity, field);
    this.#operations.push({ op: "add", subject, predicate, value: value as Value });
    if (!fieldOf(this.schema, predicate).multiple) {
      throw new Error(
        `"${predicate}" is not multiple — use .set() to replace, not .add().`,
      );
    }
    return this.#pushAdd([subject, predicate, value as Value]);
  }

  /** Remove one specific value. Works whether or not the field is multiple. */
  remove<E extends EntityDef, K extends keyof E & string>(
    entity: E,
    subject: Id,
    field: K,
    value: ValueOfField<E[K]>,
  ): this {
    assertSubjectEntity(subject, entityName(entity));
    const predicate = predicateOf(entity, field);
    this.#operations.push({ op: "remove", subject, predicate, value: value as Value });
    fieldOf(this.schema, predicate); // validate the predicate exists
    return this.#pushRemove([subject, predicate, value as Value]);
  }

  /**
   * Remove an entity entirely: every triple where it is the subject, and every
   * triple where something points AT it (or we'd leave dangling refs).
   *
   * The second scan has no index to use (SPEC §2) and walks the whole store. Fine at
   * demo scale; it is the one place an OPS index would earn its keep.
   */
  delete(subject: Id): this {
    this.#operations.push({ op: "delete", subject });
    for (const triple of this.reader.match([subject, undefined, undefined])) {
      this.#pushRemove(triple);
    }
    for (const triple of this.reader.match([undefined, undefined, { id: subject }])) {
      this.#pushRemove(triple);
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
      for (const triple of current.match([undefined, undefined, { id: operation.subject }])) {
        pushRemove(triple);
      }
      deleted.add(operation.subject);
      continue;
    }

    const { subject, predicate, value } = operation;
    const field = fieldOf(schema, predicate);
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
