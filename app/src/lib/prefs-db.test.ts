/**
 * Tests for prefs-db.ts using an in-memory SQLite database.
 * We override PREFS_DB_PATH to ':memory:' before the module is imported
 * so no file is created on disk.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

// Point the module at an in-memory DB before importing it
process.env.PREFS_DB_PATH = ':memory:';

const { getPref, setPref, getStringPref, deletePref } = await import('@/lib/prefs-db');

describe('getPref / setPref', () => {
  it('returns null for a key that has never been set', () => {
    expect(getPref('nonexistent.key')).toBeNull();
  });

  it('stores and retrieves a string value', () => {
    setPref('test.string', 'hello');
    expect(getPref<string>('test.string')).toBe('hello');
  });

  it('stores and retrieves a number value', () => {
    setPref('test.number', 42);
    expect(getPref<number>('test.number')).toBe(42);
  });

  it('stores and retrieves a boolean value', () => {
    setPref('test.bool', true);
    expect(getPref<boolean>('test.bool')).toBe(true);
  });

  it('stores and retrieves an array', () => {
    const arr = ['a', 'b', 'c'];
    setPref('test.array', arr);
    expect(getPref<string[]>('test.array')).toEqual(arr);
  });

  it('stores and retrieves an object', () => {
    const obj = { foo: 'bar', n: 1 };
    setPref('test.object', obj);
    expect(getPref<typeof obj>('test.object')).toEqual(obj);
  });

  it('overwrites an existing value (INSERT OR REPLACE)', () => {
    setPref('test.overwrite', 'first');
    setPref('test.overwrite', 'second');
    expect(getPref<string>('test.overwrite')).toBe('second');
  });
});

describe('getStringPref', () => {
  it('returns empty string for a missing key', () => {
    expect(getStringPref('missing.key')).toBe('');
  });

  it('returns the stored string value', () => {
    setPref('test.strpref', 'myvalue');
    expect(getStringPref('test.strpref')).toBe('myvalue');
  });
});

describe('deletePref', () => {
  it('removes an existing key', () => {
    setPref('test.delete', 'gone-soon');
    expect(getPref<string>('test.delete')).toBe('gone-soon');

    deletePref('test.delete');
    expect(getPref<string>('test.delete')).toBeNull();
  });

  it('is a no-op for a key that does not exist', () => {
    expect(() => deletePref('test.never-existed')).not.toThrow();
  });
});

describe('corrupt JSON tolerance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PREFS_DB_PATH = ':memory:';
  });

  it('returns null (not a crash) for a row containing invalid JSON', async () => {
    // Seed a real DB file with a raw, non-JSON row before the module is
    // imported - the module's own API cannot produce corrupt values, so we
    // simulate a partial write at the storage layer.
    const dbPath = join(tmpdir(), `prefs-corrupt-${process.pid}-${Date.now()}.sqlite`);
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    seed.prepare('INSERT INTO prefs (key, value) VALUES (?, ?)').run('corrupt.key', '{truncated-write');
    seed.close();

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.PREFS_DB_PATH = dbPath;
    vi.resetModules();
    try {
      const fresh = await import('@/lib/prefs-db');
      expect(fresh.getPref('corrupt.key')).toBeNull();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('corrupt JSON for key "corrupt.key"'));
    } finally {
      rmSync(dbPath, { force: true });
    }
  });
});
