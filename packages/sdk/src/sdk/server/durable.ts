/**
 * SPEC §5 — the Durable Objects adapter: the same contract as SqliteStorage,
 * against Cloudflare's same-isolate synchronous SQLite (`ctx.storage.sql`).
 *
 * This file is the proof of §5.4's claim that the platform IS this design:
 * every method body is a near-transliteration of sqlite.ts. `exec` caches
 * prepared statements by query text; `transactionSync` gives apply() the same
 * store+log atomicity; durability and the loss window belong to the platform's
 * output gate — no code here waits for it.
 */

import type { SqlStorage, DurableObjectStorage } from "@cloudflare/workers-types";
import { decodeValue, encodeValue } from "../shared/value.ts";
import type { Delta, Id, LogEntry, Pattern, Triple } from "../shared/types.ts";
import type { StorageAdapter } from "../shared/storage.ts";
import { isEmptyDelta } from "../shared/types.ts";

type Row = { subject: string; predicate: string; object: string };

export class DurableStorage implements StorageAdapter {
  readonly #sql: SqlStorage;
  readonly #storage: DurableObjectStorage;
  readonly epoch: number;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#sql = storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS triples (
        subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
        PRIMARY KEY (subject, predicate, object)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_po ON triples (predicate, object);
      CREATE INDEX IF NOT EXISTS idx_o  ON triples (object);
      CREATE TABLE IF NOT EXISTS log (
        version INTEGER PRIMARY KEY, actor TEXT NOT NULL,
        at INTEGER NOT NULL, delta TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const stored = this.#meta("epoch");
    this.epoch = stored !== undefined ? Number(stored) : Date.now();
    if (stored === undefined) this.#metaSet("epoch", String(this.epoch));
  }

  #meta(key: string): string | undefined {
    const row = this.#sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row === undefined ? undefined : String(row.value);
  }

  #metaSet(key: string, value: string): void {
    this.#sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key, value,
    );
  }

  get #floor(): number {
    return Number(this.#meta("floor") ?? 0);
  }

  get version(): number {
    const row = this.#sql.exec("SELECT max(version) AS v FROM log").toArray()[0];
    const v = row?.v;
    return typeof v === "number" ? v : this.#floor;
  }

  match([s, p, o]: Pattern): Triple[] {
    const eo = o === undefined ? undefined : encodeValue(o);
    const rows = (
      s !== undefined && p !== undefined && eo !== undefined
        ? this.#sql.exec("SELECT * FROM triples WHERE subject = ? AND predicate = ? AND object = ?", s, p, eo)
        : s !== undefined && p !== undefined
          ? this.#sql.exec("SELECT * FROM triples WHERE subject = ? AND predicate = ?", s, p)
          : s !== undefined && eo !== undefined
            ? this.#sql.exec("SELECT * FROM triples WHERE subject = ? AND object = ?", s, eo)
            : p !== undefined && eo !== undefined
              ? this.#sql.exec("SELECT * FROM triples WHERE predicate = ? AND object = ?", p, eo)
              : s !== undefined
                ? this.#sql.exec("SELECT * FROM triples WHERE subject = ?", s)
                : p !== undefined
                  ? this.#sql.exec("SELECT * FROM triples WHERE predicate = ?", p)
                  : eo !== undefined
                    ? this.#sql.exec("SELECT * FROM triples WHERE object = ?", eo)
                    : this.#sql.exec("SELECT * FROM triples")
    ).toArray() as unknown as Row[];
    return rows.map((r) => [r.subject, r.predicate, decodeValue(r.object)]);
  }

  matchSubjects(subjects: Id[], predicate: Id): Triple[] {
    const rows = this.#sql.exec(
      `SELECT t.subject, t.predicate, t.object FROM json_each(?) AS j
       CROSS JOIN triples AS t ON t.subject = j.value AND t.predicate = ?`,
      JSON.stringify(subjects), predicate,
    ).toArray() as unknown as Row[];
    return rows.map((r) => [r.subject, r.predicate, decodeValue(r.object)]);
  }

  topSubjects(
    subjects: Id[],
    predicate: Id,
    direction: "asc" | "desc",
    take: number,
    after?: { key: string; id: Id },
  ): Triple[] {
    const ids = JSON.stringify(subjects);
    const dir = direction === "asc" ? "ASC" : "DESC";
    const cmp = direction === "asc" ? ">" : "<";
    const rows = (
      after === undefined
        ? this.#sql.exec(
            `SELECT t.subject, t.predicate, t.object FROM json_each(?) AS j
             CROSS JOIN triples AS t ON t.subject = j.value AND t.predicate = ?
             ORDER BY t.object ${dir}, t.subject ASC LIMIT ?`,
            ids, predicate, take,
          )
        : this.#sql.exec(
            `SELECT t.subject, t.predicate, t.object FROM json_each(?) AS j
             CROSS JOIN triples AS t ON t.subject = j.value AND t.predicate = ?
             AND (t.object ${cmp} ? OR (t.object = ? AND t.subject > ?))
             ORDER BY t.object ${dir}, t.subject ASC LIMIT ?`,
            ids, predicate, after.key, after.key, after.id, take,
          )
    ).toArray() as unknown as Row[];
    return rows.map((r) => [r.subject, r.predicate, decodeValue(r.object)]);
  }

  matchRange(
    predicate: Id,
    range: { gt?: string; gte?: string; lt?: string; lte?: string },
  ): Triple[] {
    const clauses: string[] = [];
    const args: string[] = [predicate];
    if (range.gt !== undefined) { clauses.push("object > ?"); args.push(range.gt); }
    if (range.gte !== undefined) { clauses.push("object >= ?"); args.push(range.gte); }
    if (range.lt !== undefined) { clauses.push("object < ?"); args.push(range.lt); }
    if (range.lte !== undefined) { clauses.push("object <= ?"); args.push(range.lte); }
    const rows = this.#sql.exec(
      `SELECT * FROM triples WHERE predicate = ? AND ${clauses.join(" AND ") || "1=1"}`,
      ...args,
    ).toArray() as unknown as Row[];
    return rows.map((r) => [r.subject, r.predicate, decodeValue(r.object)]);
  }

  apply(delta: Delta, actor: Id): LogEntry | null {
    return this.#storage.transactionSync(() => {
      const applied: { added: Triple[]; removed: Triple[] } = { added: [], removed: [] };
      for (const [s, p, o] of delta.removed) {
        const eo = encodeValue(o);
        const hit = this.#sql.exec(
          "SELECT 1 AS x FROM triples WHERE subject = ? AND predicate = ? AND object = ?", s, p, eo,
        ).toArray().length > 0;
        if (hit) {
          this.#sql.exec("DELETE FROM triples WHERE subject = ? AND predicate = ? AND object = ?", s, p, eo);
          applied.removed.push([s, p, o]);
        }
      }
      for (const [s, p, o] of delta.added) {
        const eo = encodeValue(o);
        const hit = this.#sql.exec(
          "SELECT 1 AS x FROM triples WHERE subject = ? AND predicate = ? AND object = ?", s, p, eo,
        ).toArray().length > 0;
        if (!hit) {
          this.#sql.exec("INSERT INTO triples (subject, predicate, object) VALUES (?, ?, ?)", s, p, eo);
          applied.added.push([s, p, o]);
        }
      }
      if (isEmptyDelta(applied)) return null;
      const entry: LogEntry = {
        version: this.version + 1,
        actor,
        at: Date.now(),
        delta: applied,
      };
      this.#sql.exec(
        "INSERT INTO log (version, actor, at, delta) VALUES (?, ?, ?, ?)",
        entry.version, actor, entry.at, JSON.stringify(applied),
      );
      return entry;
    });
  }

  entriesSince(since: number): LogEntry[] | null {
    if (since < this.#floor) return null;
    const rows = this.#sql.exec(
      "SELECT version, actor, at, delta FROM log WHERE version > ? ORDER BY version ASC", since,
    ).toArray() as unknown as { version: number; actor: string; at: number; delta: string }[];
    return rows.map((r) => ({
      version: r.version, actor: r.actor, at: r.at,
      delta: JSON.parse(r.delta) as Delta,
    }));
  }

  snapshot(): { version: number; triples: Triple[] } {
    return { version: this.version, triples: this.match([undefined, undefined, undefined]) };
  }

  compact(upTo: number): void {
    const floor = Math.min(upTo, this.version);
    if (floor <= this.#floor) return;
    this.#storage.transactionSync(() => {
      this.#sql.exec("DELETE FROM log WHERE version <= ?", floor);
      this.#metaSet("floor", String(floor));
    });
  }
}
