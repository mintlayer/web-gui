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
  realpathSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('@/lib/wallet-rpc', () => ({
  rpcCall: vi.fn(),
}));

import { getPref, setPref } from '@/lib/prefs-db';
import { rpcCall } from '@/lib/wallet-rpc';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
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
const mockRealpathSync = vi.mocked(realpathSync);
const mockStatSync = vi.mocked(statSync);
const mockExecFileSync = vi.mocked(execFileSync);

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

// Helper: make execFileSync succeed for tar+find+cp calls.
// find returns a NUL-separated list containing only the tmpDir itself
// (no files inside), so the path-traversal check trivially passes.
// realpathSync is set to identity so any path passes.
function setupSuccessfulExtract() {
  // tar call → return empty buffer
  mockExecFileSync.mockReturnValueOnce(Buffer.alloc(0));
  // find call → return just the tmpDir path followed by NUL
  // We don't know the exact tmpDir value, so we capture it via a custom impl
  mockExecFileSync.mockImplementationOnce((_cmd, args) => {
    // args[0] is the tmpDir; return it so the traversal check sees only tmpDir
    const dir = (args as string[])[0];
    return Buffer.from(`${dir}\0`);
  });
  // realpathSync → identity (safe path)
  mockRealpathSync.mockImplementation((p) => p as string);
  // cp call → return empty buffer
  mockExecFileSync.mockReturnValueOnce(Buffer.alloc(0));
}

describe('installPlugin', () => {
  it('throws when archive extraction fails', async () => {
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('tar: command not found'); });
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow('Failed to extract archive');
  });

  it('throws when a path escapes the extraction directory', async () => {
    // tar succeeds
    mockExecFileSync.mockReturnValueOnce(Buffer.alloc(0));
    // find returns a path outside tmpDir
    mockExecFileSync.mockImplementationOnce((_cmd, args) => {
      const dir = (args as string[])[0];
      return Buffer.from(`${dir}\0${dir}/ok\0/etc/passwd\0`);
    });
    // realpathSync: /etc/passwd resolves to itself (outside tmpDir)
    mockRealpathSync.mockImplementation((p) => p as string);
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow(
      'Archive contains path escaping extraction directory',
    );
  });

  it('rejects archives containing a dangling symlink', async () => {
    // tar succeeds; find returns a path that realpathSync cannot resolve
    vi.mocked(execFileSync)
      .mockReturnValueOnce(Buffer.from('')) // tar
      .mockImplementationOnce((_cmd, args) => {
        const dir = (args as string[])[0];
        return Buffer.from(`${dir}\0${dir}/dangling-link\0`);
      }); // find
    vi.mocked(realpathSync)
      .mockImplementationOnce((p) => p as string) // tmpDir itself resolves fine
      .mockImplementationOnce(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });

    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow(
      'Archive contains path escaping extraction directory',
    );
  });

  it('throws when plugin.json is missing (flat layout)', async () => {
    setupSuccessfulExtract();
    mockReaddirSync.mockReturnValue([] as unknown as string[]);
    mockExistsSync.mockReturnValue(false);
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow('plugin.json not found');
  });

  it('throws when plugin.json is invalid JSON', async () => {
    setupSuccessfulExtract();
    mockReaddirSync.mockReturnValue([] as unknown as string[]);
    mockExistsSync.mockReturnValueOnce(true); // plugin.json exists
    mockReadFileSync.mockReturnValueOnce('not-json');
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow('Invalid plugin.json');
  });

  it('throws when plugin.json is missing required fields', async () => {
    setupSuccessfulExtract();
    mockReaddirSync.mockReturnValue([] as unknown as string[]);
    mockExistsSync.mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({ id: 'my-plugin' }));
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow('Invalid plugin.json');
  });

  it('throws when plugin id contains uppercase', async () => {
    setupSuccessfulExtract();
    mockReaddirSync.mockReturnValue([] as unknown as string[]);
    mockExistsSync.mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify({ ...MANIFEST, id: 'MyPlugin' }),
    );
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow('Invalid plugin.json');
  });

  it('throws when entry file is missing', async () => {
    setupSuccessfulExtract();
    mockReaddirSync.mockReturnValue([] as unknown as string[]);
    mockExistsSync
      .mockReturnValueOnce(true)   // plugin.json
      .mockReturnValueOnce(false); // entry file missing
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(MANIFEST));
    mockGetPref.mockReturnValue([]);
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow('Entry file');
  });

  it('throws when plugin is already installed', async () => {
    setupSuccessfulExtract();
    mockReaddirSync.mockReturnValue([] as unknown as string[]);
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(MANIFEST));
    mockGetPref.mockReturnValue([MANIFEST]); // already installed
    await expect(installPlugin(Buffer.from('fake'))).rejects.toThrow('already installed');
  });

  it('installs plugin successfully and updates registry', async () => {
    setupSuccessfulExtract();
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
    setupSuccessfulExtract();
    mockReaddirSync.mockReturnValue(['package'] as unknown as string[]);
    mockStatSync.mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(MANIFEST));
    mockGetPref.mockReturnValue([]);

    const result = await installPlugin(Buffer.from('fake'));
    expect(result).toMatchObject({ id: 'my-plugin' });
  });

  it('treats multi-entry directory as flat layout', async () => {
    setupSuccessfulExtract();
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

  it('calls rpcCall when method is on the allowlist', async () => {
    vi.mocked(rpcCall).mockResolvedValueOnce({ balance: '1.0' });
    const ctx = makePluginContext('my-plugin', new Request('http://localhost'));
    const result = await ctx.walletRpc('account_balance', { account: 0 });
    expect(rpcCall).toHaveBeenCalledWith('account_balance', { account: 0 });
    expect(result).toEqual({ balance: '1.0' });
  });

  it('rejects with an error when method is not on the allowlist', async () => {
    const ctx = makePluginContext('my-plugin', new Request('http://localhost'));
    await expect(ctx.walletRpc('wallet_show_seed_phrase')).rejects.toThrow(
      'Method "wallet_show_seed_phrase" is not permitted for plugins',
    );
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it('rejects arbitrary unlisted methods', async () => {
    const ctx = makePluginContext('my-plugin', new Request('http://localhost'));
    await expect(ctx.walletRpc('wallet_unlock_private_keys')).rejects.toThrow(
      'not permitted for plugins',
    );
  });
});
