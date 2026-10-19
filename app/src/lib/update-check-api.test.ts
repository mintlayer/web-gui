import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET as UPDATE_GET, POST as UPDATE_POST } from '../pages/api/update-check';
import { clearUpdateCache } from './update-check';

/**
 * Contract for /api/update-check: honest degradation when the release feed
 * is unreachable, no auto-install unless the (step-up protected) pref is
 * on, and pre-releases excluded from auto-install unless explicitly
 * included.
 */

vi.mock('@/lib/step-up', () => ({
  requireStepUp: vi.fn(() => ({ ok: true as const })),
  totpFromBody: vi.fn(() => '123456'),
}));

const prefs: Record<string, unknown> = {};
vi.mock('@/lib/prefs-db', () => ({
  getPref: (key: string) => (key in prefs ? prefs[key] : null),
  setPref: (key: string, value: unknown) => {
    prefs[key] = value;
  },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function respond(releases: unknown[]) {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(releases), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function req(body?: unknown, method = 'GET'): Parameters<typeof UPDATE_GET>[0] {
  return {
    request: new Request('http://x/api/update-check', {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    clientAddress: '127.0.0.1',
  } as Parameters<typeof UPDATE_GET>[0];
}

function wire(tag: string, over: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    name: tag,
    body: 'notes',
    prerelease: false,
    html_url: `https://github.com/mintlayer/web-gui/releases/tag/${tag}`,
    published_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

let dir: string;
const origDir = process.env.FEATURE_REQUESTS_DIR;

beforeEach(async () => {
  vi.clearAllMocks();
  for (const k of Object.keys(prefs)) delete prefs[k];
  clearUpdateCache();
  dir = await mkdtemp(join(tmpdir(), 'update-check-api-'));
  process.env.FEATURE_REQUESTS_DIR = dir;
});

afterEach(async () => {
  if (origDir === undefined) delete process.env.FEATURE_REQUESTS_DIR;
  else process.env.FEATURE_REQUESTS_DIR = origDir;
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/update-check', () => {
  it('reports the newest release and no auto-queue by default', async () => {
    respond([wire('v9.9.9')]);
    const res = await UPDATE_GET(req());
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.update.available).toBe(true);
    expect(data.update.latest.tag).toBe('v9.9.9');
    expect(data.autoInstall).toBe(false);
    expect(data.autoQueued).toBe(false);
    await expect(async () => await import('node:fs/promises').then((m) => m.readFile(join(dir, 'web-gui.req'), 'utf8'))).rejects.toThrow();
  });

  it('degrades honestly when the feed is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const res = await UPDATE_GET(req());
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.update.available).toBe(false);
    expect(data.error).toBe('release check unavailable');
  });

  it('auto-queues an upgrade when the pref is on and the enabler is wired', async () => {
    prefs.ml_update_auto_install = true;
    respond([wire('v9.9.9')]);
    const data = await (await UPDATE_GET(req())).json();
    expect(data.autoQueued).toBe(true);
    const stored = JSON.parse(await writeFile_());
    expect(stored).toEqual({ action: 'upgrade', service: 'web-gui', tag: 'v9.9.9' });
  });

  it('never auto-installs a pre-release unless pre-releases are included', async () => {
    prefs.ml_update_auto_install = true;
    respond([wire('v9.9.9-rc1', { prerelease: true })]);
    expect((await (await UPDATE_GET(req())).json()).autoQueued).toBe(false);
    prefs.ml_update_include_prereleases = true;
    clearUpdateCache();
    respond([wire('v9.9.9-rc1', { prerelease: true })]);
    expect((await (await UPDATE_GET(req())).json()).autoQueued).toBe(true);
  });

  it('carries the declared bitcoind version into the auto-queued request', async () => {
    prefs.ml_update_auto_install = true;
    respond([wire('v9.9.9', { body: 'bitcoind: 26.0' })]);
    await UPDATE_GET(req());
    const stored = JSON.parse(await writeFile_());
    expect(stored.bitcoind).toBe('26.0');
  });

  it('does not auto-retry after a failed upgrade result', async () => {
    prefs.ml_update_auto_install = true;
    const { writeFile: wf, mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await wf(
      join(dir, 'web-gui.result'),
      JSON.stringify({ ok: false, at: Date.now(), error: 'pull failed for: web-gui' }),
    );
    respond([wire('v9.9.9')]);
    const data = await (await UPDATE_GET(req())).json();
    expect(data.autoQueued).toBe(false);
    await expect(writeFile_()).rejects.toThrow();
  });
});

async function writeFile_(): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(join(dir, 'web-gui.req'), 'utf8');
}

describe('POST /api/update-check (auto-install toggle)', () => {
  it('stores the pref and persists it', async () => {
    const res = await UPDATE_POST(req({ auto_install: true }, 'POST'));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(prefs.ml_update_auto_install).toBe(true);
    const again = await (await UPDATE_GET(req())).json();
    expect(again.autoInstall).toBe(true);
  });

  it('rejects non-boolean values', async () => {
    expect((await UPDATE_POST(req({ auto_install: 'yes' }, 'POST'))).status).toBe(400);
    expect((await UPDATE_POST(req({}, 'POST'))).status).toBe(400);
  });

  it('stores the pre-release preference when provided', async () => {
    const res = await UPDATE_POST(req({ auto_install: true, include_prereleases: true }, 'POST'));
    expect(res.status).toBe(200);
    expect(prefs.ml_update_include_prereleases).toBe(true);
    const again = await (await UPDATE_GET(req())).json();
    expect(again.includePrereleases).toBe(true);
  });

  it('rejects a non-boolean pre-release flag', async () => {
    expect((await UPDATE_POST(req({ auto_install: true, include_prereleases: 'sure' }, 'POST'))).status).toBe(400);
  });

  it('rejects a broken body', async () => {
    const res = await UPDATE_POST({
      request: new Request('http://x/api/update-check', { method: 'POST', body: 'not json' }),
      clientAddress: '127.0.0.1',
    } as Parameters<typeof UPDATE_POST>[0]);
    expect(res.status).toBe(400);
  });
});
