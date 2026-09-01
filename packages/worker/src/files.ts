/**
 * App files live IN the cell — a table beside the triples, same SQLite, same
 * durability. An app is just files; deploying is writing them.
 */
import type { SqlStorage } from "@cloudflare/workers-types";

export class AppFiles {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS app_files (
      app TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (app, path)
    )`);
  }

  list(app: string): { path: string; size: number; updatedAt: number }[] {
    return (this.sql
      .exec("SELECT path, length(content) AS size, updated_at FROM app_files WHERE app = ? ORDER BY path", app)
      .toArray() as { path: string; size: number; updated_at: number }[])
      .map((r) => ({ path: r.path, size: r.size, updatedAt: r.updated_at }));
  }

  apps(): string[] {
    return (this.sql.exec("SELECT DISTINCT app FROM app_files ORDER BY app").toArray() as { app: string }[])
      .map((r) => r.app);
  }

  read(app: string, path: string): string | null {
    const row = this.sql.exec("SELECT content FROM app_files WHERE app = ? AND path = ?", app, path).toArray()[0];
    return row === undefined ? null : String(row.content);
  }

  write(app: string, path: string, content: string): void {
    this.sql.exec(
      `INSERT INTO app_files (app, path, content, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(app, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      app, path, content, Date.now(),
    );
  }

  delete(app: string, path: string): boolean {
    const existed = this.read(app, path) !== null;
    this.sql.exec("DELETE FROM app_files WHERE app = ? AND path = ?", app, path);
    return existed;
  }
}

export function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "text/plain; charset=utf-8";
}
