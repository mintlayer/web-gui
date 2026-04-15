/**
 * Tests for prefs-db.ts using an in-memory SQLite database.
 * We override PREFS_DB_PATH to ':memory:' before the module is imported
 * so no file is created on disk.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// Point the module at an in-memory DB before importing it
process.env.PREFS_DB_PATH = ':memory:';

const { getPref, setPref, getStringPref } = await import('@/lib/prefs-db');

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
