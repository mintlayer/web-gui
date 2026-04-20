/**
 * Plugin system — install, registry, load, and context helpers.
 *
 * Plugins are trusted server-side Node.js modules uploaded as .tgz archives.
 * They run in the same process as the app (no sandboxing), consistent with
 * how Astro integrations and VS Code extensions work.
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getPref, setPref } from './prefs-db';
import { rpcCall } from './wallet-rpc';

// ── Config ────────────────────────────────────────────────────────────────────

export const PLUGINS_DIR = process.env.PLUGINS_DIR ?? '/app/plugins';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PluginManifest {
  id: string;
  name: string;
  navLabel: string;
  version: string;
  entry: string;
}

export interface PluginResult {
  title: string;
  html: string;
}

export interface PluginContext {
  walletRpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  getPref: (key: string) => unknown;
  setPref: (key: string, value: unknown) => void;
  indexerBaseUrl: string | null;
  request: Request;
}

export interface PluginModule {
  handler: (request: Request, context: PluginContext) => Promise<Response | PluginResult>;
}

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_ID = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

function validateManifest(raw: unknown): PluginManifest {
  if (typeof raw !== 'object' || !raw) throw new Error('plugin.json must be a JSON object');
  const m = raw as Record<string, unknown>;
  for (const field of ['id', 'name', 'navLabel', 'version', 'entry']) {
    if (typeof m[field] !== 'string' || !(m[field] as string).trim()) {
      throw new Error(`plugin.json missing or invalid field: ${field}`);
    }
  }
  if (!VALID_ID.test(m.id as string)) {
    throw new Error(
      `plugin id "${m.id}" must match /^[a-z0-9][a-z0-9-]*[a-z0-9]$/ (no uppercase, no leading/trailing dash)`,
    );
  }
  return m as unknown as PluginManifest;
}

// ── Registry (SQLite-backed) ──────────────────────────────────────────────────

export function getInstalledPlugins(): PluginManifest[] {
  return getPref<PluginManifest[]>('plugins.registry') ?? [];
}

export function getEnabledPlugins(): PluginManifest[] {
  return getInstalledPlugins().filter(
    (p) => getPref<boolean>(`plugins.${p.id}.enabled`) === true,
  );
}

export function togglePlugin(id: string, enabled: boolean): void {
  if (!getInstalledPlugins().find((p) => p.id === id)) {
    throw new Error(`Plugin "${id}" is not installed`);
  }
  setPref(`plugins.${id}.enabled`, enabled);
}

// ── Install / Uninstall ───────────────────────────────────────────────────────

export async function installPlugin(buffer: Buffer): Promise<PluginManifest> {
  const tmpTgz = `/tmp/plugin-upload-${Date.now()}.tgz`;
  const tmpDir = `/tmp/plugin-extract-${Date.now()}`;

  try {
    writeFileSync(tmpTgz, buffer);
    mkdirSync(tmpDir, { recursive: true });

    try {
      execSync(`tar -xzf "${tmpTgz}" -C "${tmpDir}"`, { timeout: 30_000 });
    } catch (err) {
      throw new Error(`Failed to extract archive: ${(err as Error).message}`);
    }

    // Support both flat layout and single-directory layout (npm pack style)
    let pluginRoot = tmpDir;
    const entries = readdirSync(tmpDir);
    if (entries.length === 1 && statSync(join(tmpDir, entries[0])).isDirectory()) {
      pluginRoot = join(tmpDir, entries[0]);
    }

    const manifestPath = join(pluginRoot, 'plugin.json');
    if (!existsSync(manifestPath)) {
      throw new Error('plugin.json not found in archive root');
    }

    let manifest: PluginManifest;
    try {
      manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf-8')));
    } catch (err) {
      throw new Error(`Invalid plugin.json: ${(err as Error).message}`);
    }

    const entryPath = join(pluginRoot, manifest.entry);
    if (!existsSync(entryPath)) {
      throw new Error(`Entry file "${manifest.entry}" not found in archive`);
    }

    const existing = getInstalledPlugins();
    if (existing.find((p) => p.id === manifest.id)) {
      throw new Error(`Plugin "${manifest.id}" is already installed. Uninstall it first.`);
    }

    const destDir = join(PLUGINS_DIR, manifest.id);
    mkdirSync(PLUGINS_DIR, { recursive: true });
    execSync(`cp -r "${pluginRoot}" "${destDir}"`, { timeout: 10_000 });

    existing.push(manifest);
    setPref('plugins.registry', existing);
    setPref(`plugins.${manifest.id}.enabled`, false);
    invalidatePluginCache(manifest.id);

    return manifest;
  } finally {
    try { rmSync(tmpTgz); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
}

export function uninstallPlugin(id: string): void {
  const plugins = getInstalledPlugins();
  const idx = plugins.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Plugin "${id}" is not installed`);

  try { rmSync(join(PLUGINS_DIR, id), { recursive: true }); } catch { /* ignore */ }

  plugins.splice(idx, 1);
  setPref('plugins.registry', plugins);
  setPref(`plugins.${id}.enabled`, null);
  invalidatePluginCache(id);
}

// ── Module cache & loader ─────────────────────────────────────────────────────

const _generations = new Map<string, number>();
const _cache = new Map<string, { gen: number; module: PluginModule }>();

function invalidatePluginCache(id: string): void {
  _generations.set(id, (_generations.get(id) ?? 0) + 1);
  _cache.delete(id);
}

export async function loadPluginHandler(id: string): Promise<PluginModule> {
  const gen = _generations.get(id) ?? 0;
  const cached = _cache.get(id);
  if (cached && cached.gen === gen) return cached.module;

  const manifest = getInstalledPlugins().find((p) => p.id === id);
  if (!manifest) throw new Error(`Plugin "${id}" is not installed`);

  const entryPath = join(PLUGINS_DIR, id, manifest.entry);
  // Query parameter busts Node's ESM cache after reinstall
  const url = `file://${entryPath}?gen=${gen}`;
  const module = await import(url) as PluginModule;

  if (typeof module.handler !== 'function') {
    throw new Error(`Plugin "${id}" must export a "handler" function`);
  }

  _cache.set(id, { gen, module });
  return module;
}

// ── Context factory ───────────────────────────────────────────────────────────

export function makePluginContext(pluginId: string, request: Request): PluginContext {
  return {
    walletRpc: (method, params = {}) => rpcCall(method, params),
    getPref: (key) => getPref(`plugins.${pluginId}.data.${key}`),
    setPref: (key, value) => setPref(`plugins.${pluginId}.data.${key}`, value),
    indexerBaseUrl:
      process.env.INDEXER_ENABLED === 'true'
        ? (process.env.INDEXER_URL ?? null)
        : null,
    request,
  };
}
