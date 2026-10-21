// SQLite persistence (node:sqlite, no native addons). Each service keeps its hot state in memory
// and writes through to these tables so a restart restores users, documents, RTDB and objects.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class Store {
  readonly db: DatabaseSync;

  constructor(file = ":memory:") {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (ns, key));
      CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, data BLOB NOT NULL);
    `);
  }

  all<T>(ns: string): [string, T][] {
    const rows = this.db.prepare("SELECT key, value FROM kv WHERE ns = ?").all(ns) as { key: string; value: string }[];
    return rows.map((r) => [r.key, JSON.parse(r.value) as T]);
  }

  get<T>(ns: string, key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE ns = ? AND key = ?").get(ns, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  put(ns: string, key: string, value: unknown): void {
    this.db.prepare("INSERT INTO kv (ns, key, value) VALUES (?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value").run(ns, key, JSON.stringify(value));
  }

  delete(ns: string, key: string): void {
    this.db.prepare("DELETE FROM kv WHERE ns = ? AND key = ?").run(ns, key);
  }

  clear(ns: string): void {
    this.db.prepare("DELETE FROM kv WHERE ns = ?").run(ns);
  }

  putBlob(key: string, data: Buffer): void {
    this.db.prepare("INSERT INTO blobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data").run(key, data);
  }

  getBlob(key: string): Buffer | undefined {
    const row = this.db.prepare("SELECT data FROM blobs WHERE key = ?").get(key) as { data: Uint8Array } | undefined;
    return row ? Buffer.from(row.data) : undefined;
  }

  deleteBlob(key: string): void {
    this.db.prepare("DELETE FROM blobs WHERE key = ?").run(key);
  }

  transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try { fn(); this.db.exec("COMMIT"); } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  close(): void { this.db.close(); }
}
