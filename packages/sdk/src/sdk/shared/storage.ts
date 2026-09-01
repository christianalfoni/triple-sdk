/**
 * SPEC §3 (Log) and §5 (Storage adapter).
 *
 * The adapter owns BOTH the store and the log, because a write has to land in both
 * atomically — if it lands in the store but not the log, a reconnecting client will
 * never learn about it and will silently diverge.
 *
 * One interface, implemented on both sides. `MemoryStorage` is used by the demo
 * server and the demo client alike; IndexedDB and Postgres are later swaps behind
 * the same three methods.
 */

import { Store } from "./store.ts";
import { encodeValue } from "./value.ts";
import type { Delta, Id, LogEntry, Pattern, Triple } from "./types.ts";
import { isEmptyDelta } from "./types.ts";

export interface StorageAdapter {
  /**
   * A persistent history identity, when the adapter has one (§7.3). Durable storage
   * mints it once and keeps it with the data, so a server restart is the SAME
   * history and clients replay the log instead of resyncing. Absent for in-memory
   * storage, where every boot genuinely IS a new history.
   */
  readonly epoch?: number;

  /** The highest committed version. Cheap — never derived by fetching triples. */
  readonly version: number;

  match(pattern: Pattern): Triple[];
  /** Commit a delta. Returns the log entry, or null if nothing actually changed. */
  apply(delta: Delta, actor: Id): LogEntry | null;
  /**
   * Every entry with `version > since` — the catch-up primitive (SPEC §7.3).
   *
   * Returns NULL when `since` predates what the log still retains: how much
   * history to keep is the implementation's choice, and a cursor from before the
   * retention floor cannot be honestly extended. The caller must fall back to
   * state — drop the cache and re-query the store.
   */
  entriesSince(since: number): LogEntry[] | null;
  snapshot(): { version: number; triples: Triple[] };
  /**
   * §7.3 — forget log entries at or below `upTo`. The store IS the snapshot, so
   * nothing is lost but replayability: a cursor from below the new floor gets
   * NULL from `entriesSince` and resyncs from state. Optional — an adapter that
   * never compacts just retains everything.
   */
  compact?(upTo: number): void;
}

export class MemoryStorage implements StorageAdapter {
  readonly store = new Store();

  /** SPEC §3 — append-only, monotonic, no gaps above the retention floor. */
  readonly #log: LogEntry[] = [];

  /** Versions at or below this have been compacted away (§7.3). */
  #floor = 0;

  /** The highest version committed. 0 means "nothing ever happened". */
  get version(): number {
    return this.#floor + this.#log.length;
  }

  match(pattern: Pattern): Triple[] {
    return this.store.match(pattern);
  }

  matchSubjects(subjects: Id[], predicate: Id): Triple[] {
    const out: Triple[] = [];
    for (const subject of subjects) {
      for (const triple of this.store.match([subject, predicate, undefined])) out.push(triple);
    }
    return out;
  }

  /**
   * §6.6 — bounded top-K over the ORDER-PRESERVING encoding, so ranking equals
   * value order with plain string compares. Same contract as the SQL adapter's,
   * which is what lets the deferred-policy window path treat both alike.
   */
  topSubjects(
    subjects: Id[],
    predicate: Id,
    direction: "asc" | "desc",
    take: number,
    after?: { key: string; id: Id },
  ): Triple[] {
    const sign = direction === "desc" ? -1 : 1;
    const beats = (aKey: string, aId: Id, bKey: string, bId: Id): number => {
      const byValue = aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
      const directed = sign * byValue;
      return directed !== 0 ? directed : aId < bId ? -1 : aId > bId ? 1 : 0;
    };

    const top: { key: string; triple: Triple }[] = [];
    for (const subject of subjects) {
      for (const triple of this.store.match([subject, predicate, undefined])) {
        const key = encodeValue(triple[2]);
        if (after && beats(key, subject, after.key, after.id) <= 0) continue;
        const worst = top[top.length - 1];
        if (top.length === take && worst && beats(key, subject, worst.key, worst.triple[0]) >= 0) {
          continue;
        }
        let lo = 0;
        let hi = top.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (beats(key, subject, top[mid]!.key, top[mid]!.triple[0]) < 0) hi = mid;
          else lo = mid + 1;
        }
        top.splice(lo, 0, { key, triple });
        if (top.length > take) top.pop();
      }
    }
    return top.map((entry) => entry.triple);
  }

  apply(delta: Delta, actor: Id): LogEntry | null {
    // The store tells us what ACTUALLY changed — re-adding an existing triple is a
    // no-op (SPEC §1.1), and a no-op must not consume a version number, or clients
    // would see phantom deltas.
    const effective = this.store.apply(delta);
    if (isEmptyDelta(effective)) return null;

    const entry: LogEntry = {
      version: this.version + 1,
      delta: effective,
      actor,
      at: Date.now(),
    };
    this.#log.push(entry);
    return entry;
  }

  entriesSince(since: number): LogEntry[] | null {
    if (since < this.#floor) return null;
    return this.#log.slice(since - this.#floor);
  }

  /**
   * Drop every entry at or below `upTo`. The state those entries folded into lives
   * on in the store — compaction says "below here, the fold IS the record". Cursors
   * from before the floor get NULL from entriesSince and must resync from state.
   */
  compact(upTo: number): void {
    const floor = Math.min(upTo, this.version);
    if (floor <= this.#floor) return;
    this.#log.splice(0, floor - this.#floor);
    this.#floor = floor;
  }

  snapshot(): { version: number; triples: Triple[] } {
    return { version: this.version, triples: this.store.snapshot() };
  }
}
