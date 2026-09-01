/**
 * SPEC §5 — the durable storage adapter, on Node's built-in SQLite.
 *
 * The same four-method contract as MemoryStorage, made durable: a `triples` table
 * (the STORE), a `log` table (the LOG), and `apply()` as ONE SQL transaction across
 * both — the atomicity the interface demands, now enforced by the database.
 *
 * `node:sqlite` is synchronous, which is why this adapter exists before Postgres:
 * it slots into the synchronous StorageAdapter contract untouched. Postgres forces
 * the async-adapter refactor (§11.1).
 *
 * Durability changes one semantic: the EPOCH survives restarts. A fresh in-memory
 * server is a new history (epoch = process start); a reopened database is the SAME
 * history, so the epoch is minted once and persisted — reconnecting clients replay
 * the log across a server restart instead of resyncing from scratch.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { StorageAdapter } from "../shared/storage.ts";
import { isEmptyDelta } from "../shared/types.ts";
import type { Delta, Id, LogEntry, Pattern, Triple } from "../shared/types.ts";
import { decodeValue, encodeValue } from "../shared/value.ts";

export class SqliteStorage implements StorageAdapter {
  readonly #db: DatabaseSync;
  readonly epoch: number;

  readonly #stmt: Record<string, StatementSync>;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
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

    this.#stmt = {
      metaGet: this.#db.prepare("SELECT value FROM meta WHERE key = ?"),
      metaSet: this.#db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"),
      insert: this.#db.prepare("INSERT OR IGNORE INTO triples VALUES (?, ?, ?)"),
      remove: this.#db.prepare(
        "DELETE FROM triples WHERE subject = ? AND predicate = ? AND object = ?",
      ),
      appendLog: this.#db.prepare("INSERT INTO log VALUES (?, ?, ?, ?)"),
      maxVersion: this.#db.prepare("SELECT MAX(version) AS v FROM log"),
      logSince: this.#db.prepare("SELECT * FROM log WHERE version > ? ORDER BY version"),
      logCompact: this.#db.prepare("DELETE FROM log WHERE version <= ?"),
      all: this.#db.prepare("SELECT * FROM triples"),
      s: this.#db.prepare("SELECT * FROM triples WHERE subject = ?"),
      sp: this.#db.prepare("SELECT * FROM triples WHERE subject = ? AND predicate = ?"),
      spo: this.#db.prepare(
        "SELECT * FROM triples WHERE subject = ? AND predicate = ? AND object = ?",
      ),
      so: this.#db.prepare("SELECT * FROM triples WHERE subject = ? AND object = ?"),
      p: this.#db.prepare("SELECT * FROM triples WHERE predicate = ?"),
      po: this.#db.prepare("SELECT * FROM triples WHERE predicate = ? AND object = ?"),
      o: this.#db.prepare("SELECT * FROM triples WHERE object = ?"),
      // json_each turns an id array into a table: ONE cached statement regardless
      // of how many subjects — statement preparation was 95% of the chunked cost.
      // CROSS JOIN pins the join order (SQLite's documented lever): the id list
      // DRIVES with PK seeks; letting the planner flip it means probing an
      // unindexed ephemeral table once per row of the predicate. That hangs.
      subjectsIn: this.#db.prepare(
        `SELECT t.subject, t.predicate, t.object FROM json_each(?) AS j
         CROSS JOIN triples AS t
         WHERE t.subject = j.value AND t.predicate = ?`,
      ),
      topAsc: this.#db.prepare(
        `SELECT t.subject, t.predicate, t.object FROM json_each(?) AS j
         CROSS JOIN triples AS t
         WHERE t.subject = j.value AND t.predicate = ?
         ORDER BY t.object ASC, t.subject ASC LIMIT ?`,
      ),
      topDesc: this.#db.prepare(
        `SELECT t.subject, t.predicate, t.object FROM json_each(?) AS j
         CROSS JOIN triples AS t
         WHERE t.subject = j.value AND t.predicate = ?
         ORDER BY t.object DESC, t.subject ASC LIMIT ?`,
      ),
      topAscAfter: this.#db.prepare(
        `SELECT t.subject, t.predicate, t.object FROM json_each(?) AS j
         CROSS JOIN triples AS t
         WHERE t.subject = j.value AND t.predicate = ?
           AND (t.object > ? OR (t.object = ? AND t.subject > ?))
         ORDER BY t.object ASC, t.subject ASC LIMIT ?`,
      ),
      topDescAfter: this.#db.prepare(
        `SELECT t.subject, t.predicate, t.object FROM json_each(?) AS j
         CROSS JOIN triples AS t
         WHERE t.subject = j.value AND t.predicate = ?
           AND (t.object < ? OR (t.object = ? AND t.subject > ?))
         ORDER BY t.object DESC, t.subject ASC LIMIT ?`,
      ),
    };

    // The epoch is part of the DATA's identity, so it lives with the data (§7.3).
    const stored = this.#meta("epoch");
    this.epoch = stored !== undefined ? Number(stored) : Date.now();
    if (stored === undefined) this.#stmt.metaSet!.run("epoch", String(this.epoch));
  }

  #meta(key: string): string | undefined {
    const row = this.#stmt.metaGet!.get(key) as { value: string } | undefined;
    return row?.value;
  }

  get #floor(): number {
    return Number(this.#meta("floor") ?? 0);
  }

  get version(): number {
    const row = this.#stmt.maxVersion!.get() as { v: number | null };
    return row.v ?? this.#floor;
  }

  match([s, p, o]: Pattern): Triple[] {
    const eo = o === undefined ? undefined : encodeValue(o);
    const rows = (
      s !== undefined && p !== undefined && eo !== undefined ? this.#stmt.spo!.all(s, p, eo)
      : s !== undefined && p !== undefined ? this.#stmt.sp!.all(s, p)
      : s !== undefined && eo !== undefined ? this.#stmt.so!.all(s, eo)
      : s !== undefined ? this.#stmt.s!.all(s)
      : p !== undefined && eo !== undefined ? this.#stmt.po!.all(p, eo)
      : p !== undefined ? this.#stmt.p!.all(p)
      : eo !== undefined ? this.#stmt.o!.all(eo)
      : this.#stmt.all!.all()
    ) as { subject: string; predicate: string; object: string }[];
    return rows.map((r) => [r.subject, r.predicate, decodeValue(r.object)]);
  }

  apply(delta: Delta, actor: Id): LogEntry | null {
    this.#db.exec("BEGIN");
    try {
      const removed: Triple[] = [];
      const added: Triple[] = [];
      // `changes` tells us what ACTUALLY happened — the effective delta (§2.1).
      for (const t of delta.removed) {
        if (this.#stmt.remove!.run(t[0], t[1], encodeValue(t[2])).changes > 0) removed.push(t);
      }
      for (const t of delta.added) {
        if (this.#stmt.insert!.run(t[0], t[1], encodeValue(t[2])).changes > 0) added.push(t);
      }

      const effective = { added, removed };
      if (isEmptyDelta(effective)) {
        this.#db.exec("COMMIT");
        return null;
      }

      const entry: LogEntry = {
        version: this.version + 1,
        delta: effective,
        actor,
        at: Date.now(),
      };
      this.#stmt.appendLog!.run(entry.version, actor, entry.at, JSON.stringify(effective));
      this.#db.exec("COMMIT");
      return entry;
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  entriesSince(since: number): LogEntry[] | null {
    if (since < this.#floor) return null;
    const rows = this.#stmt.logSince!.all(since) as {
      version: number; actor: string; at: number; delta: string;
    }[];
    return rows.map((r) => ({
      version: r.version, actor: r.actor, at: r.at,
      delta: JSON.parse(r.delta) as Delta,
    }));
  }

  compact(upTo: number): void {
    const floor = Math.min(upTo, this.version);
    if (floor <= this.#floor) return;
    this.#db.exec("BEGIN");
    try {
      this.#stmt.logCompact!.run(floor);
      this.#stmt.metaSet!.run("floor", String(floor));
      this.#db.exec("COMMIT");
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  matchRange(
    predicate: Id,
    range: { gt?: string; gte?: string; lt?: string; lte?: string },
  ): Triple[] {
    // Built per bound-shape and cached: `object` HOLDS the encoded form, so SQL
    // comparison IS value comparison, riding idx_po (§6.9).
    const clauses: string[] = [];
    const args: string[] = [predicate];
    if (range.gt !== undefined) { clauses.push("object > ?"); args.push(range.gt); }
    if (range.gte !== undefined) { clauses.push("object >= ?"); args.push(range.gte); }
    if (range.lt !== undefined) { clauses.push("object < ?"); args.push(range.lt); }
    if (range.lte !== undefined) { clauses.push("object <= ?"); args.push(range.lte); }
    const shape = clauses.join(" AND ") || "1=1";
    let statement = this.#rangeStatements.get(shape);
    if (!statement) {
      statement = this.#db.prepare(
        `SELECT subject, predicate, object FROM triples WHERE predicate = ? AND ${shape}`,
      );
      this.#rangeStatements.set(shape, statement);
    }
    const rows = statement.all(...args) as { subject: string; predicate: string; object: string }[];
    return rows.map((r) => [r.subject, r.predicate, decodeValue(r.object)]);
  }

  #rangeStatements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  matchSubjects(subjects: Id[], predicate: Id): Triple[] {
    const rows = this.#stmt.subjectsIn!.all(JSON.stringify(subjects), predicate) as {
      subject: string; predicate: string; object: string;
    }[];
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
    const rows = (
      after
        ? this.#stmt[direction === "desc" ? "topDescAfter" : "topAscAfter"]!.all(
            ids, predicate, after.key, after.key, after.id, take,
          )
        : this.#stmt[direction === "desc" ? "topDesc" : "topAsc"]!.all(ids, predicate, take)
    ) as { subject: string; predicate: string; object: string }[];
    return rows.map((r) => [r.subject, r.predicate, decodeValue(r.object)]);
  }

  snapshot(): { version: number; triples: Triple[] } {
    return { version: this.version, triples: this.match([undefined, undefined, undefined]) };
  }

  close(): void {
    this.#db.close();
  }
}
