import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isBitcoinNetwork,
  isFeatureEnablerAvailable,
  isFeatureService,
  isRequestPending,
  queueFeatureRequest,
  readFeatureResult,
} from './feature-requests';

let dir: string;
const origDir = process.env.FEATURE_REQUESTS_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'feature-requests-'));
  process.env.FEATURE_REQUESTS_DIR = dir;
});

afterEach(async () => {
  if (origDir === undefined) delete process.env.FEATURE_REQUESTS_DIR;
  else process.env.FEATURE_REQUESTS_DIR = origDir;
  await rm(dir, { recursive: true, force: true });
});

describe('enum guards', () => {
  it('accepts only known services and networks', () => {
    expect(isFeatureService('bitcoin')).toBe(true);
    expect(isFeatureService('indexer')).toBe(true);
    expect(isFeatureService('node')).toBe(false);
    expect(isFeatureService('__proto__')).toBe(false);
    expect(isBitcoinNetwork('mainnet')).toBe(true);
    expect(isBitcoinNetwork('regtest')).toBe(true);
    expect(isBitcoinNetwork('signet')).toBe(false);
    expect(isBitcoinNetwork(42)).toBe(false);
  });
});

describe('availability', () => {
  it('is true for an existing directory and false when missing', async () => {
    expect(await isFeatureEnablerAvailable()).toBe(true);
    process.env.FEATURE_REQUESTS_DIR = join(dir, 'nope');
    expect(await isFeatureEnablerAvailable()).toBe(false);
  });
});

describe('queueFeatureRequest', () => {
  it('writes an atomic compact request for bitcoin with defaults', async () => {
    await queueFeatureRequest({ action: 'enable', service: 'bitcoin', network: 'regtest', pruned: false });
    const files = await stat(join(dir, 'bitcoin.req'));
    expect(files.isFile()).toBe(true);
    expect(JSON.parse(await readFile(join(dir, 'bitcoin.req'), 'utf8'))).toEqual({
      action: 'enable',
      service: 'bitcoin',
      network: 'regtest',
      pruned: false,
    });
    // no temp litter
    await expect(stat(join(dir, '.bitcoin.req.tmp'))).rejects.toThrow();
  });

  it('defaults bitcoin to mainnet + pruned and drops extra fields for indexer', async () => {
    await queueFeatureRequest({ action: 'enable', service: 'bitcoin' });
    expect(JSON.parse(await readFile(join(dir, 'bitcoin.req'), 'utf8'))).toEqual({
      action: 'enable',
      service: 'bitcoin',
      network: 'mainnet',
      pruned: true,
    });
    await queueFeatureRequest({
      action: 'disable',
      service: 'indexer',
      network: 'regtest',
      pruned: true,
    } as never);
    expect(JSON.parse(await readFile(join(dir, 'indexer.req'), 'utf8'))).toEqual({
      action: 'disable',
      service: 'indexer',
    });
  });

  it('rejects a second request while one is pending and allows it after pickup', async () => {
    await queueFeatureRequest({ action: 'enable', service: 'indexer' });
    // link-based claim: the second request loses the race and gets false
    await expect(queueFeatureRequest({ action: 'enable', service: 'indexer' })).resolves.toBe(false);
    // sidecar picked the file up (renamed away)
    await rm(join(dir, 'indexer.req'));
    await expect(queueFeatureRequest({ action: 'disable', service: 'indexer' })).resolves.toBe(true);
  });

  it('refuses invalid services and actions', async () => {
    await expect(
      queueFeatureRequest({ action: 'enable', service: 'node' as never }),
    ).rejects.toThrow(/invalid service/);
    await expect(
      queueFeatureRequest({ action: 'restart' as never, service: 'bitcoin' }),
    ).rejects.toThrow(/invalid action/);
  });

  it('isRequestPending reflects the file state', async () => {
    expect(await isRequestPending('bitcoin')).toBe(false);
    await queueFeatureRequest({ action: 'enable', service: 'bitcoin' });
    expect(await isRequestPending('bitcoin')).toBe(true);
  });
});

describe('readFeatureResult', () => {
  it('returns null when no result exists', async () => {
    expect(await readFeatureResult('bitcoin')).toBeNull();
  });

  it('parses ok results and caps errors', async () => {
    await writeFile(
      join(dir, 'indexer.result'),
      JSON.stringify({ ok: false, at: 1700000000000, error: 'x'.repeat(2000) }),
    );
    const result = await readFeatureResult('indexer');
    expect(result?.ok).toBe(false);
    expect(result?.at).toBe(1700000000000);
    expect(result?.error?.length).toBe(400);
  });

  it('tolerates malformed result files', async () => {
    await writeFile(join(dir, 'indexer.result'), '{"ok":');
    expect(await readFeatureResult('indexer')).toBeNull();
    await writeFile(join(dir, 'indexer.result'), '{"at":1}');
    expect(await readFeatureResult('indexer')).toBeNull();
  });
});
