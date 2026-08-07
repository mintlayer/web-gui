import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPerms, rpcCall, tolerant, guarded, toolHandlers } from './mcp-server.mjs';

let tmp;

/** Write a prefs SQLite with the given key→value (JSON) rows and return its path. */
function prefsDb(name, prefs) {
  const path = join(tmp, `${name}.sqlite`);
  const db = new Database(path);
  db.exec('CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT)');
  const ins = db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(prefs)) ins.run(k, JSON.stringify(v));
  db.close();
  process.env.PREFS_DB_PATH = path;
  return path;
}

const okFetch = (result) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result }) })));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mcp-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.PREFS_DB_PATH;
  vi.unstubAllGlobals();
});

describe('readPerms — fail closed', () => {
  it('returns all-false when the prefs DB is missing', () => {
    process.env.PREFS_DB_PATH = join(tmp, 'nope.sqlite');
    expect(readPerms()).toEqual({ enabled: false, allowActions: false, allowSpend: false });
  });

  it('returns all-false when the prefs table is absent (corrupt DB)', () => {
    const path = join(tmp, 'corrupt.sqlite');
    const db = new Database(path);
    db.exec('CREATE TABLE other (x)');
    db.close();
    process.env.PREFS_DB_PATH = path;
    expect(readPerms()).toEqual({ enabled: false, allowActions: false, allowSpend: false });
  });

  it('reads all three flags when set', () => {
    prefsDb('full', { 'mcp.enabled': true, 'mcp.allow_actions': true, 'mcp.allow_spend': true });
    expect(readPerms()).toEqual({ enabled: true, allowActions: true, allowSpend: true });
  });

  it('treats missing keys as false', () => {
    prefsDb('partial', { 'mcp.enabled': true });
    expect(readPerms()).toEqual({ enabled: true, allowActions: false, allowSpend: false });
  });
});

describe('guarded — permission gate', () => {
  it('denies and never runs the fn when MCP is disabled', async () => {
    prefsDb('off', { 'mcp.enabled': false });
    const fn = vi.fn();
    const r = await guarded(['account_balance'], fn);
    expect(r.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs the fn and JSON-wraps the result when allowed', async () => {
    prefsDb('read', { 'mcp.enabled': true });
    const r = await guarded(['account_balance'], async () => ({ coins: '1.5' }));
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('coins');
  });

  it('denies a spend method when allow_spend is off, before running the fn', async () => {
    prefsDb('readonly', { 'mcp.enabled': true });
    const fn = vi.fn();
    const r = await guarded(['address_send'], fn);
    expect(r.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('denies if ANY method in the set is not permitted', async () => {
    prefsDb('actions', { 'mcp.enabled': true, 'mcp.allow_actions': true });
    const fn = vi.fn();
    // address_new (actions, allowed) + address_send (spend, denied) → whole call denied
    const r = await guarded(['address_new', 'address_send'], fn);
    expect(r.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('maps a thrown RPC error to a deny result', async () => {
    prefsDb('read2', { 'mcp.enabled': true });
    const r = await guarded(['account_balance'], async () => {
      throw new Error('insufficient funds');
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('insufficient funds');
  });
});

describe('rpcCall', () => {
  it('returns the result on success', async () => {
    okFetch({ height: 42 });
    expect(await rpcCall('node_best_block_height')).toEqual({ height: 42 });
  });

  it('throws on an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(rpcCall('x')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a JSON-RPC error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ error: { message: 'bad params' } }) })));
    await expect(rpcCall('x')).rejects.toThrow(/bad params/);
  });
});

describe('tolerant', () => {
  it('returns the result when the call succeeds', async () => {
    okFetch(7);
    expect(await tolerant('node_best_block_height', {})).toBe(7);
  });

  it('returns an "unavailable" string when the call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    expect(await tolerant('x', {})).toMatch(/unavailable/);
  });
});

describe('tool handlers — end to end under full permissions', () => {
  it('every registered tool runs and returns a non-error result', async () => {
    prefsDb('all', { 'mcp.enabled': true, 'mcp.allow_actions': true, 'mcp.allow_spend': true });
    okFetch({});
    const calls = [
      ['get_status', {}],
      ['get_balance', { account: 0, with_locked: 'Unlocked' }],
      ['list_addresses', { account: 0, include_change: false }],
      ['list_transactions', { account: 0, limit: 50 }],
      ['list_utxos', { account: 0 }],
      ['get_staking_overview', { account: 0 }],
      ['list_orders', { account: 0, scope: 'own' }],
      ['list_orders', { account: 0, scope: 'all' }],
      ['new_address', { account: 0 }],
      ['set_staking', { account: 0, enabled: true }],
      ['set_staking', { account: 0, enabled: false }],
      ['send_coins', { account: 0, address: 'mtc1qexample', amount: '1.5' }],
      ['wallet_rpc', { method: 'account_balance', params: {} }],
    ];
    for (const [name, args] of calls) {
      const r = await toolHandlers[name](args);
      expect(r.isError, `${name} should not error`).toBeUndefined();
    }
  });

  it('a spend tool is blocked when only read access is granted', async () => {
    prefsDb('readonly2', { 'mcp.enabled': true });
    okFetch({});
    const r = await toolHandlers.send_coins({ account: 0, address: 'mtc1qexample', amount: '1.5' });
    expect(r.isError).toBe(true);
  });

  it('wallet_rpc escape hatch cannot reach an unmapped method', async () => {
    prefsDb('all2', { 'mcp.enabled': true, 'mcp.allow_actions': true, 'mcp.allow_spend': true });
    okFetch({});
    const r = await toolHandlers.wallet_rpc({ method: 'wallet_show_seed_phrase', params: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not available/);
  });
});
