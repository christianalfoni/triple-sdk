/**
 * SPEC §1 — Data model.
 *
 * This is the entire vocabulary of the system. Everything else in the SDK is a
 * function that produces or consumes one of these five types.
 */

/** An entity id. Globally meaningful, minted by whoever creates the entity (§0.4, §8.4). */
export type Id = string;

/** A pointer from one subject to another. The only structured value we allow. */
export type Ref = { id: Id };

/** The object position of a triple: a literal scalar, or a pointer. */
export type Value = string | number | boolean | Ref;

/**
 * The atom of the system.
 *
 *   ["user_1", "user/name", "Christian"]
 *   ["todo_9", "todo/owner", { id: "user_1" }]
 *
 * A predicate is a namespaced string. There is no IRI resolution (§11).
 */
export type Triple = [subject: Id, predicate: Id, object: Value];

/**
 * The only thing that ever moves through the system — client to server, server to
 * client, into storage, out of the log.
 *
 * SPEC §1.2: removes are applied before adds, so that a replace is order-independent.
 */
export type Delta = {
  added: Triple[];
  removed: Triple[];
};

/**
 * A Triple with holes. `undefined` in a position means "match anything".
 *
 *   [undefined, "user/name", undefined]  → every name triple
 *   ["user_1",  undefined,   undefined]  → every fact about user_1
 */
export type Pattern = [
  subject: Id | undefined,
  predicate: Id | undefined,
  object: Value | undefined,
];

/**
 * Anything that can be read by pattern: a Store, or a StorageAdapter wrapping one.
 * Both the query executor (§6) and Transaction (§9) only ever need this much.
 */
export interface Readable {
  match(pattern: Pattern): Triple[];
  /**
   * Batch form: every triple with this predicate for ANY of these subjects. In
   * memory it is sugar; against SQL it is the difference between one query and one
   * per subject (§11.4). Callers fall back to looping `match` when absent.
   */
  matchSubjects?(subjects: Id[], predicate: Id): Triple[];
  /**
   * §6.6 fast path: among these subjects, the `take` best-ranked triples of this
   * predicate — the encoded object's lexicographic order IS value order, so a SQL
   * adapter answers with `ORDER BY object LIMIT ?` and never materializes the rest.
   * `after` is the keyset cursor as an (encodedValue, id) pair.
   */
  topSubjects?(
    subjects: Id[],
    predicate: Id,
    direction: "asc" | "desc",
    take: number,
    after?: { key: string; id: Id },
  ): Triple[];
  /**
   * §6.9 fast path: every triple of this predicate whose ENCODED object falls in
   * the range — bounds are encoded strings, because the encoding is
   * order-preserving (§6.6): a SQL adapter answers with an index range read on
   * (predicate, object) and never materializes the rest. Callers fall back to a
   * predicate scan when absent.
   */
  matchRange?(
    predicate: Id,
    range: { gt?: string; gte?: string; lt?: string; lte?: string },
  ): Triple[];
}

/**
 * SPEC §3 — one entry in the append-only log.
 *
 * `version` is the sync cursor and is assigned by the server only (§3.2).
 *
 * `actor` is whoever made the change — any id you choose. It is the reason a triple
 * can stay a 3-tuple instead of carrying a fourth "named graph" position (§3.1).
 * Nothing reads it yet; §7 needs it so a client can recognise the echo of its own
 * write, and §10 needs it for audit.
 *
 * `at` is for display; never order by it (clock skew).
 */
export type LogEntry = {
  version: number;
  delta: Delta;
  actor: Id;
  at: number;
};

/** True if the delta would change nothing. */
export function isEmptyDelta(delta: Delta): boolean {
  return delta.added.length === 0 && delta.removed.length === 0;
}
