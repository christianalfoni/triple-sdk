/**
 * SPEC §2 — Store.
 *
 * A set of triples with two indexes. Both are nested Maps; there is no clever data
 * structure here. The point of an "index" is only this: a Map lets you jump straight
 * to the triples you want instead of scanning all of them.
 *
 *   SPO  Map<subject, Map<predicate, Set<encodedObject>>>   "all facts about X"
 *   POS  Map<predicate, Map<encodedObject, Set<subject>>>   "all entities where p = v"
 *
 * Every triple is stored in BOTH. That is the trade: writes cost 2x, reads get cheap.
 */

import type { Delta, Id, Pattern, Readable, Triple, Value } from "./types.ts";
import { decodeValue, encodeValue, tripleKey } from "./value.ts";

export class Store {
  /** subject → predicate → set of encoded objects */
  readonly #spo = new Map<Id, Map<Id, Set<string>>>();
  /** predicate → encoded object → set of subjects */
  readonly #pos = new Map<Id, Map<string, Set<Id>>>();

  #size = 0;

  /** How many triples the store holds. */
  get size(): number {
    return this.#size;
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /**
   * Find every triple matching a pattern. `undefined` in a position = wildcard.
   *
   * The eight cases below are the entire reason the indexes exist. Read them as a
   * table: which index can answer this shape of question without scanning?
   */
  match([s, p, o]: Pattern): Triple[] {
    const results: Triple[] = [];

    // --- subject is known: the SPO index takes us straight there -----------------
    if (s !== undefined) {
      const byPredicate = this.#spo.get(s);
      if (!byPredicate) return results;

      if (p !== undefined) {
        const objects = byPredicate.get(p);
        if (!objects) return results;

        if (o !== undefined) {
          // (s, p, o) — fully bound. This is just an existence check.
          if (objects.has(encodeValue(o))) results.push([s, p, o]);
        } else {
          // (s, p, ?)
          for (const encoded of objects) results.push([s, p, decodeValue(encoded)]);
        }
        return results;
      }

      // (s, ?, o) and (s, ?, ?) — walk this subject's predicates.
      const wanted = o === undefined ? undefined : encodeValue(o);
      for (const [predicate, objects] of byPredicate) {
        for (const encoded of objects) {
          if (wanted !== undefined && encoded !== wanted) continue;
          results.push([s, predicate, decodeValue(encoded)]);
        }
      }
      return results;
    }

    // --- subject unknown, predicate known: the POS index takes over --------------
    if (p !== undefined) {
      const byObject = this.#pos.get(p);
      if (!byObject) return results;

      if (o !== undefined) {
        // (?, p, o) — the classic lookup: "who has this value for this field?"
        const subjects = byObject.get(encodeValue(o));
        if (subjects) for (const subject of subjects) results.push([subject, p, o]);
        return results;
      }

      // (?, p, ?) — every triple using this predicate.
      for (const [encoded, subjects] of byObject) {
        const value = decodeValue(encoded);
        for (const subject of subjects) results.push([subject, p, value]);
      }
      return results;
    }

    // --- neither subject nor predicate known ------------------------------------
    // (?, ?, o) and (?, ?, ?) require a full scan: we have no OPS index (SPEC §2).
    // In practice queries always bind at least a predicate, so this stays cold.
    const wanted = o === undefined ? undefined : encodeValue(o);
    for (const [subject, byPredicate] of this.#spo) {
      for (const [predicate, objects] of byPredicate) {
        for (const encoded of objects) {
          if (wanted !== undefined && encoded !== wanted) continue;
          results.push([subject, predicate, decodeValue(encoded)]);
        }
      }
    }
    return results;
  }

  /** Every triple in the store. */
  snapshot(): Triple[] {
    return this.match([undefined, undefined, undefined]);
  }

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  /**
   * Apply a delta and return the EFFECTIVE delta — what actually changed.
   *
   * SPEC §1.1: the store is a set, so adding a triple that is already present is a
   * no-op and must not be reported. Callers (the log, the subscription router) react
   * to what changed, not to what was requested.
   *
   * SPEC §1.2: removes run before adds, so a replace is safe in any array order.
   */
  apply(delta: Delta): Delta {
    const removed: Triple[] = [];
    const added: Triple[] = [];

    for (const triple of delta.removed) {
      if (this.#remove(triple)) removed.push(triple);
    }
    for (const triple of delta.added) {
      if (this.#add(triple)) added.push(triple);
    }

    return { added, removed };
  }

  /** Insert into both indexes. Returns false if it was already there. */
  #add([subject, predicate, object]: Triple): boolean {
    const encoded = encodeValue(object);

    let byPredicate = this.#spo.get(subject);
    if (!byPredicate) this.#spo.set(subject, (byPredicate = new Map()));
    let objects = byPredicate.get(predicate);
    if (!objects) byPredicate.set(predicate, (objects = new Set()));
    if (objects.has(encoded)) return false;
    objects.add(encoded);

    let byObject = this.#pos.get(predicate);
    if (!byObject) this.#pos.set(predicate, (byObject = new Map()));
    let subjects = byObject.get(encoded);
    if (!subjects) byObject.set(encoded, (subjects = new Set()));
    subjects.add(subject);

    this.#size++;
    return true;
  }

  /** Delete from both indexes. Returns false if it wasn't there. */
  #remove([subject, predicate, object]: Triple): boolean {
    const encoded = encodeValue(object);

    const byPredicate = this.#spo.get(subject);
    const objects = byPredicate?.get(predicate);
    if (!objects?.delete(encoded)) return false;
    if (objects.size === 0) byPredicate!.delete(predicate);
    if (byPredicate!.size === 0) this.#spo.delete(subject);

    const byObject = this.#pos.get(predicate);
    const subjects = byObject?.get(encoded);
    subjects?.delete(subject);
    if (subjects?.size === 0) byObject!.delete(encoded);
    if (byObject?.size === 0) this.#pos.delete(predicate);

    this.#size--;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Convenience
  // ---------------------------------------------------------------------------

  /** Read a single value, or undefined. For `multiple: false` fields. */
  value(subject: Id, predicate: Id): Value | undefined {
    return this.match([subject, predicate, undefined])[0]?.[2];
  }

  /** Read all values. For `multiple: true` fields. */
  values(subject: Id, predicate: Id): Value[] {
    return this.match([subject, predicate, undefined]).map((t) => t[2]);
  }
}

/**
 * A read-only view of `base` as it would look AFTER `delta` is applied, without
 * applying it. Removes are hidden, adds appear — §1.2 order, so a triple in both
 * halves ends up present.
 *
 * Used by the write-side policy check (§10.4), which must see the post-state before
 * committing. It is also exactly the shape of the optimistic overlay (§8.1): the
 * pending layer is `withDelta(confirmed, pending)`.
 */
export function withDelta(base: Readable, delta: Delta): Readable {
  return {
    match(pattern: Pattern): Triple[] {
      const removed = new Set(delta.removed.map(tripleKey));
      const results = base.match(pattern).filter((t) => !removed.has(tripleKey(t)));
      const present = new Set(results.map(tripleKey));
      for (const triple of delta.added) {
        if (!matchesPattern(triple, pattern)) continue;
        const key = tripleKey(triple);
        if (present.has(key)) continue;
        present.add(key);
        results.push(triple);
      }
      return results;
    },
  };
}

function matchesPattern([s, p, o]: Triple, [ps, pp, po]: Pattern): boolean {
  if (ps !== undefined && ps !== s) return false;
  if (pp !== undefined && pp !== p) return false;
  if (po !== undefined && encodeValue(po) !== encodeValue(o)) return false;
  return true;
}
