import Database from 'better-sqlite3';
import { join } from 'node:path';

const DB_PATH = process.env.PREFS_DB_PATH ?? join('/app/prefs', 'mintlayer_prefs.sqlite');

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.exec(`CREATE TABLE IF NOT EXISTS prefs (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
  }
  return _db;
}

export function getPref<T>(key: string): T | null {
  const row = db().prepare('SELECT value FROM prefs WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

export function setPref<T>(key: string, value: T): void {
  db().prepare('INSERT OR REPLACE INTO prefs (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

export function getStringPref(key: string): string {
  return getPref<string>(key) ?? '';
}
