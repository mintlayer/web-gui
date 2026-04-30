import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prefs-db', () => ({
  getPref: vi.fn(),
  setPref: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('@/lib/wallet-rpc', () => ({
  rpcCall: vi.fn(),
}));

import { getPref, setPref } from '@/lib/prefs-db';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import {
  getInstalledPlugins,
  getEnabledPlugins,
  togglePlugin,
  installPlugin,
  uninstallPlugin,
  makePluginContext,
} from '@/lib/plugins';

const mockGetPref = vi.mocked(getPref);
const mockSetPref = vi.mocked(setPref);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockStatSync = vi.mocked(statSync);
const mockExecSync = vi.mocked(execSync);

const MANIFEST = {
  id: 'my-plugin',
  name: 'My Plugin',
  navLabel: 'My Plugin',
  version: '1.0.0',
  entry: 'index.js',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── getInstalledPlugins ───────────────────────────────────────────────────────

describe('getInstalledPlugins', () => {
  it('returns empty array when no registry', () => {
    mockGetPref.mockReturnValue(null);
    expect(getInstalledPlugins()).toEqual([]);
  });

  it('returns array from registry', () => {
    mockGetPref.mockReturnValue([MANIFEST]);
    expect(getInstalledPlugins()).toEqual([MANIFEST]);
  });
});

// ── getEnabledPlugins ─────────────────────────────────────────────────────────

describe('getEnabledPlugins', () => {
  it('returns empty array when no plugins installed', () => {
    mockGetPref.mockReturnValue(null);
    expect(getEnabledPlugins()).toEqual([]);
  });

  it('returns only plugins with enabled=true', () => {
    const other = { ...MANIFEST, id: 'other-plugin' };
    mockGetPref
      .mockReturnValueOnce([MANIFEST, other]) // registry
      .mockReturnValueOnce(true)              // my-plugin enabled
      .mockReturnValueOnce(false);            // other-plugin disabled
    expect(getEnabledPlugins()).toEqual([MANIFEST]);
  });

  it('excludes plugin when enabled pref is missing', () => {
    mockGetPref
      .mockReturnValueOnce([MANIFEST]) // registry
      .mockReturnValueOnce(null);      // enabled not set
    expect(getEnabledPlugins()).toEqual([]);
  });
});

// ── togglePlugin ──────────────────────────────────────────────────────────────

describe('togglePlugin', () => {
  it('throws when plugin is not installed', () => {
    mockGetPref.mockReturnValue([]);
    expect(() => togglePlugin('unknown', true)).toThrow('not installed');
  });

  it('calls setPref with enabled=true', () => {
    mockGetPref.mockReturnValue([MANIFEST]);
    togglePlugin('my-plugin', true);
    expect(mockSetPref).toHaveBeenCalledWith('plugins.my-plugin.enabled', true);
  });

  it('calls setPref with enabled=false', () => {
    mockGetPref.mockReturnValue([MANIFEST]);
    togglePlugin('my-plugin', false);
    expect(mockSetPref).toHaveBeenCalledWith('plugins.my-plugin.enabled', false);
  });
});

// ── uninstallPlugin ───────────────────────────────────────────────────────────

describe('uninstallPlugin', () => {
  it('throws when plugin is not installed', () => {
    mockGetPref.mockReturnValue([]);
    expect(() => uninstallPlugin('unknown')).toThrow('not installed');
  });

  it('removes plugin from registry', () => {
    const other = { ...MANIFEST, id: 'other-plugin' };
    mockGetPref.mockReturnValue([MANIFEST, other]);
    uninstallPlugin('my-plugin');
    expect(mockSetPref).toHaveBeenCalledWith('plugins.registry', [other]);
    expect(mockSetPref).toHaveBeenCalledWith('plugins.my-plugin.enabled', null);
  });

  it('tolerates rmSync failure gracefully', () => {
    mockGetPref.mockReturnValue([MANIFEST]);
    vi.mocked(rmSync).mockImplementationOnce(() => { throw new Error('ENOENT'); });
    // should not throw
    expect(() => uninstallPlugin('my-plugin')).not.toThrow();
    expect(mockSetPref).toHaveBeenCalledWith('plugins.registry', []);
  });
});

// ── installPlugin ─────────────────────────────────────────────────────────────

describe('installPlugin', () => {
  it('throws when archive extraction fails', async () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('tar: command not found'); });
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow('Failed to extract archive');
  });

  it('throws when plugin.json is missing (flat layout)', async () => {
    mockExecSync.mockReturnValue(Buffer.alloc(0));
    mockReaddirSync.mockReturnValue([] as unknown as string[]);
    mockExistsSync.mockReturnValue(false);
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow('plugin.json not found');
  });

  it('throws when plugin.json is invalid JSON', async () => {
    mockExecSync.mockReturnValue(Buffer.alloc(0));
    mockReaddirSync.mockReturnValue([] as unknown as string[]);
    mockExistsSync.mockReturnValueOnce(true); // plugin.json exists
    mockReadFileSync.mockReturnValueOnce('not-json');
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow('Invalid plugin.json');
  });

  it('throws when plugin.json is missing required fields', async () => {
    mockExecSync.mockReturnValue(Buffer.alloc(0));
    mockReaddirSync.mockReturnValue([] as unknown as string[]);
    mockExistsSync.mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({ id: 'my-plugin' }));
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow('Invalid plugin.json');
  });

  it('throws when plugin id contains uppercase', async () => {
    mockExecSync.mockReturnValue(Buffer.alloc(0));
    mockReaddirSync.mockReturnValue([] as unknown as string[]);
    mockExistsSync.mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify({ ...MANIFEST, id: 'MyPlugin' }),
    );
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow('Invalid plugin.json');
  });

  it('throws when entry file is missing', async () => {
    mockExecSync.mockReturnValue(Buffer.alloc(0));
    mockReaddirSync.mockReturnValue([] as unknown as string[]);
    mockExistsSync
      .mockReturnValueOnce(true)   // plugin.json
      .mockReturnValueOnce(false); // entry file missing
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(MANIFEST));
    mockGetPref.mockReturnValue([]);
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow('Entry file');
  });

  it('throws when plugin is already installed', async () => {
    mockExecSync.mockReturnValue(Buffer.alloc(0));
    mockReaddirSync.mockReturnValue([] as unknown as string[]);
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(MANIFEST));
    mockGetPref.mockReturnValue([MANIFEST]); // already installed
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow('already installed');
  });

  it('installs plugin successfully and updates registry', async () => {
    mockExecSync.mockReturnValue(Buffer.alloc(0));
    mockReaddirSync.mockReturnValue([] as unknown as string[]);
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(MANIFEST));
    mockGetPref.mockReturnValue([]);

    const result = await installPlugin(Buffer.from('fake'));
    expect(result).toMatchObject({ id: 'my-plugin' });
    expect(mockSetPref).toHaveBeenCalledWith('plugins.registry', [MANIFEST]);
    expect(mockSetPref).toHaveBeenCalledWith('plugins.my-plugin.enabled', false);
  });

  it('handles single-directory npm pack layout', async () => {
    mockExecSync.mockReturnValue(Buffer.alloc(0));
    mockReaddirSync.mockReturnValue(['package'] as unknown as string[]);
    mockStatSync.mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(MANIFEST));
    mockGetPref.mockReturnValue([]);

    const result = await installPlugin(Buffer.from('fake'));
    expect(result).toMatchObject({ id: 'my-plugin' });
  });

  it('treats multi-entry directory as flat layout', async () => {
    mockExecSync.mockReturnValue(Buffer.alloc(0));
    // Two entries → not single-dir layout
    mockReaddirSync.mockReturnValue(['plugin.json', 'index.js'] as unknown as string[]);
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(MANIFEST));
    mockGetPref.mockReturnValue([]);

    const result = await installPlugin(Buffer.from('fake'));
    expect(result).toMatchObject({ id: 'my-plugin' });
  });
});

// ── makePluginContext ─────────────────────────────────────────────────────────

describe('makePluginContext', () => {
  it('returns a context with required shape', () => {
    const req = new Request('http://localhost/test');
    const ctx = makePluginContext('my-plugin', req);
    expect(typeof ctx.walletRpc).toBe('function');
    expect(typeof ctx.getPref).toBe('function');
    expect(typeof ctx.setPref).toBe('function');
    expect(ctx.request).toBe(req);
  });

  it('namespaces getPref under plugins.<id>.data', () => {
    const req = new Request('http://localhost/test');
    const ctx = makePluginContext('my-plugin', req);
    ctx.getPref('my-key');
    expect(mockGetPref).toHaveBeenCalledWith('plugins.my-plugin.data.my-key');
  });

  it('namespaces setPref under plugins.<id>.data', () => {
    const req = new Request('http://localhost/test');
    const ctx = makePluginContext('my-plugin', req);
    ctx.setPref('my-key', 42);
    expect(mockSetPref).toHaveBeenCalledWith('plugins.my-plugin.data.my-key', 42);
  });

  it('returns null indexerBaseUrl when INDEXER_ENABLED is unset', () => {
    delete process.env.INDEXER_ENABLED;
    const ctx = makePluginContext('my-plugin', new Request('http://localhost'));
    expect(ctx.indexerBaseUrl).toBeNull();
  });

  it('returns INDEXER_URL when INDEXER_ENABLED=true', () => {
    process.env.INDEXER_ENABLED = 'true';
    process.env.INDEXER_URL = 'http://indexer:3000';
    const ctx = makePluginContext('my-plugin', new Request('http://localhost'));
    expect(ctx.indexerBaseUrl).toBe('http://indexer:3000');
    delete process.env.INDEXER_ENABLED;
    delete process.env.INDEXER_URL;
  });
});
