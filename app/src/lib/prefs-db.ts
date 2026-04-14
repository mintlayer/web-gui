import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

function defaultPrefsPath(): string {
  if (process.env.PREFS_DB_PATH) return process.env.PREFS_DB_PATH;
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appdata, 'Mintlayer', 'prefs', 'mintlayer_prefs.sqlite');
  }
  return join('/app/prefs', 'mintlayer_prefs.sqlite'); // Docker default
}

const DB_PATH = defaultPrefsPath();

let _db: Database | null = null;

function db(): Database {
  if (!_db) {
    mkdirSync(join(DB_PATH, '..'), { recursive: true });
    _db = new Database(DB_PATH);
    _db.exec(`CREATE TABLE IF NOT EXISTS prefs (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
  }
  return _db;
}

export function getPref<T>(key: string): T | null {
  const row = db().prepare('SELECT value FROM prefs WHERE key = ?').get(key) as { value: string } | null;
  return row ? (JSON.parse(row.value) as T) : null;
}

export function setPref<T>(key: string, value: T): void {
  db().prepare('INSERT OR REPLACE INTO prefs (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

export function getStringPref(key: string): string {
  return getPref<string>(key) ?? '';
}
