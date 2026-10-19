import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POST as ENABLE } from '../pages/api/features/enable';
import { POST as UPGRADE } from '../pages/api/features/upgrade';
import { POST as ROLLBACK } from '../pages/api/features/rollback';
import { POST as DISABLE } from '../pages/api/features/disable';
import { GET as STATUS } from '../pages/api/features/status';
import { queueFeatureRequest } from './feature-requests';
import { requireStepUp } from '@/lib/step-up';

/**
 * API contract for the optional-services enable/disable/status routes
 * (tests live outside src/pages — astro compiles colocated tests there
 * into phantom endpoints). Contract: availability gate, step-up
 * requirement, strict body validation, "already enabled/queued"
 * idempotency, exact request payloads, honest status output.
 */

vi.mock('@/lib/step-up', () => ({
  requireStepUp: vi.fn(() => ({ ok: true as const })),
  totpFromBody: vi.fn(() => '123456'),
}));

const isBitcoinEnabled = vi.fn(() => false);

vi.mock('@/lib/bitcoin-wallet', () => ({
  isBitcoinEnabled: (...a: unknown[]) => isBitcoinEnabled(...(a as [])),
}));

function req(path: string, body: unknown, method = 'POST'): Parameters<typeof ENABLE>[0] {
  return {
    request: new Request(`http://x${path}`, {
      method,
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }),
    clientAddress: '127.0.0.1',
  } as Parameters<typeof ENABLE>[0];
}

async function readReq(name: string): Promise<Record<string, unknown>> {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>;
}

let dir: string;
const origDir = process.env.FEATURE_REQUESTS_DIR;

beforeEach(async () => {
  vi.clearAllMocks();
  isBitcoinEnabled.mockReturnValue(false);
  dir = await mkdtemp(join(tmpdir(), 'features-api-'));
  process.env.FEATURE_REQUESTS_DIR = dir;
  delete process.env.INDEXER_ENABLED;
});

afterEach(async () => {
  if (origDir === undefined) delete process.env.FEATURE_REQUESTS_DIR;
  else process.env.FEATURE_REQUESTS_DIR = origDir;
  await rm(dir, { recursive: true, force: true });
});

describe('POST /api/features/enable', () => {
  it('returns 503 when the enabler volume is not mounted', async () => {
    process.env.FEATURE_REQUESTS_DIR = join(dir, 'missing');
    const res = await ENABLE(req('/api/features/enable', { service: 'indexer' }));
    expect(res.status).toBe(503);
  });

  it('rejects unknown services before step-up', async () => {
    const { requireStepUp } = await import('@/lib/step-up');
    const res = await ENABLE(req('/api/features/enable', { service: 'node-daemon' }));
    expect(res.status).toBe(400);
    expect(requireStepUp).not.toHaveBeenCalled();
  });

  it('propagates step-up failure', async () => {
    const { requireStepUp } = await import('@/lib/step-up');
    (requireStepUp as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      ok: false,
      status: 401,
      error: 'Wrong 2FA code',
    });
    const res = await ENABLE(req('/api/features/enable', { service: 'indexer' }));
    expect(res.status).toBe(401);
  });

  it('returns 409 when the service is already enabled', async () => {
    isBitcoinEnabled.mockReturnValueOnce(true);
    expect((await ENABLE(req('/api/features/enable', { service: 'bitcoin' }))).status).toBe(409);
    process.env.INDEXER_ENABLED = 'true';
    expect((await ENABLE(req('/api/features/enable', { service: 'indexer' }))).status).toBe(409);
  });

  it('returns 409 when a request is already queued', async () => {
    await queueFeatureRequest({ action: 'enable', service: 'indexer' });
    expect((await ENABLE(req('/api/features/enable', { service: 'indexer' }))).status).toBe(409);
  });

  it('rejects a bad bitcoin network and a malformed body', async () => {
    expect((await ENABLE(req('/api/features/enable', { service: 'bitcoin', network: 'signet' }))).status).toBe(400);
    const bad = ENABLE({
      request: new Request('http://x/api/features/enable', { method: 'POST', body: 'not json' }),
      clientAddress: '127.0.0.1',
    } as Parameters<typeof ENABLE>[0]);
    expect((await bad).status).toBe(400);
  });

  it('queues bitcoin with mainnet+pruned defaults and explicit overrides', async () => {
    expect((await ENABLE(req('/api/features/enable', { service: 'bitcoin' }))).status).toBe(202);
    expect(await readReq('bitcoin.req')).toEqual({
      action: 'enable',
      service: 'bitcoin',
      network: 'mainnet',
      pruned: true,
    });
    await rm(join(dir, 'bitcoin.req'));
    await ENABLE(req('/api/features/enable', { service: 'bitcoin', network: 'regtest', pruned: false }));
    expect(await readReq('bitcoin.req')).toEqual({
      action: 'enable',
      service: 'bitcoin',
      network: 'regtest',
      pruned: false,
    });
  });

  it('queues a bare indexer request without bitcoin-only fields', async () => {
    expect((await ENABLE(req('/api/features/enable', { service: 'indexer' }))).status).toBe(202);
    const body = await readReq('indexer.req');
    expect(body).toEqual({ action: 'enable', service: 'indexer' });
    expect(body).not.toHaveProperty('network');
    expect(body).not.toHaveProperty('pruned');
  });
});

describe('POST /api/features/disable', () => {
  it('refuses to disable a service that is not enabled', async () => {
    expect((await DISABLE(req('/api/features/disable', { service: 'bitcoin' }))).status).toBe(409);
    expect((await DISABLE(req('/api/features/disable', { service: 'indexer' }))).status).toBe(409);
  });

  it('queues a disable request for an enabled service', async () => {
    isBitcoinEnabled.mockReturnValue(true);
    expect((await DISABLE(req('/api/features/disable', { service: 'bitcoin' }))).status).toBe(202);
    expect(await readReq('bitcoin.req')).toEqual({ action: 'disable', service: 'bitcoin' });
    expect(await readReq('bitcoin.req')).not.toHaveProperty('network');
    expect(await readReq('bitcoin.req')).not.toHaveProperty('pruned');
  });

  it('validates service and availability like enable', async () => {
    process.env.FEATURE_REQUESTS_DIR = join(dir, 'missing');
    expect((await DISABLE(req('/api/features/disable', { service: 'indexer' }))).status).toBe(503);
    process.env.FEATURE_REQUESTS_DIR = dir;
    expect((await DISABLE(req('/api/features/disable', { service: 'web' }))).status).toBe(400);
  });
});

describe('GET /api/features/status', () => {
  it('reports availability, enabled state, pending and results', async () => {
    isBitcoinEnabled.mockReturnValue(true);
    process.env.INDEXER_ENABLED = 'true';
    await queueFeatureRequest({ action: 'disable', service: 'indexer' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'bitcoin.result'), JSON.stringify({ ok: true, at: 1700000000000 }));

    const res = await STATUS(req('/api/features/status', null, 'GET'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available: boolean;
      services: Record<string, { enabled: boolean; pending: boolean; lastResult: { ok: boolean } | null }>;
    };
    expect(body.available).toBe(true);
    expect(body.services.bitcoin.enabled).toBe(true);
    expect(body.services.bitcoin.pending).toBe(false);
    expect(body.services.bitcoin.lastResult?.ok).toBe(true);
    expect(body.services.indexer.enabled).toBe(true);
    expect(body.services.indexer.pending).toBe(true);
    expect(body.services.indexer.lastResult).toBeNull();
  });

  it('reports unavailable when the volume is missing', async () => {
    process.env.FEATURE_REQUESTS_DIR = join(dir, 'missing');
    const res = await STATUS(req('/api/features/status', null, 'GET'));
    const body = (await res.json()) as { available: boolean };
    expect(body.available).toBe(false);
  });
});

describe('POST /api/features/upgrade', () => {
  it('queues an upgrade with the declared tag and bitcoind version', async () => {
    const res = await UPGRADE(req('/api/features/upgrade', { tag: 'v1.0.0-rc3', bitcoind: '26.0' }));
    expect(res.status).toBe(202);
    const stored = await readReq('web-gui.req');
    expect(stored).toEqual({ action: 'upgrade', service: 'web-gui', tag: 'v1.0.0-rc3', bitcoind: '26.0' });
  });

  it('queues without a bitcoind field when the release declares none', async () => {
    const res = await UPGRADE(req('/api/features/upgrade', { tag: 'v1.0.0-rc3' }));
    expect(res.status).toBe(202);
    expect(await readReq('web-gui.req')).toEqual({ action: 'upgrade', service: 'web-gui', tag: 'v1.0.0-rc3' });
  });

  it('rejects missing, unversioned or oversized tags before step-up', async () => {
    for (const tag of ['', '1.0.0', 'v', 'v' + 'x'.repeat(45), undefined]) {
      const res = await UPGRADE(req('/api/features/upgrade', { tag }));
      expect(res.status).toBe(400);
    }
    expect(requireStepUp).not.toHaveBeenCalled();
    await expect(readReq('web-gui.req')).rejects.toThrow();
  });

  it('rejects malformed bitcoind versions', async () => {
    const res = await UPGRADE(req('/api/features/upgrade', { tag: 'v1.0.0-rc3', bitcoind: '26; rm -rf' }));
    expect(res.status).toBe(400);
  });

  it('refuses a second queued upgrade', async () => {
    expect((await UPGRADE(req('/api/features/upgrade', { tag: 'v1.0.0-rc3' }))).status).toBe(202);
    expect((await UPGRADE(req('/api/features/upgrade', { tag: 'v1.0.0-rc3' }))).status).toBe(409);
  });
});

describe('POST /api/features/rollback', () => {
  it('queues a rollback request', async () => {
    const res = await ROLLBACK(req('/api/features/rollback', {}));
    expect(res.status).toBe(202);
    expect(await readReq('web-gui.req')).toEqual({ action: 'rollback', service: 'web-gui' });
  });

  it('refuses when an upgrade is already queued', async () => {
    expect((await UPGRADE(req('/api/features/upgrade', { tag: 'v1.0.0-rc3' }))).status).toBe(202);
    expect((await ROLLBACK(req('/api/features/rollback', {}))).status).toBe(409);
  });
});

describe('GET /api/features/status (web-gui service)', () => {
  it('reports the running app as enabled with pending and result state', async () => {
    await queueFeatureRequest({ action: 'upgrade', service: 'web-gui', tag: 'v1.0.0-rc3' });
    const res = await STATUS(req('/api/features/status', undefined, 'GET'));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.services['web-gui'].enabled).toBe(true);
    expect(data.services['web-gui'].pending).toBe(true);
  });
});
