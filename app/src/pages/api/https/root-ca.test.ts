import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:fs/promises so we don't touch the real filesystem
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { GET } from '@/pages/api/https/root-ca';
import { readFile } from 'node:fs/promises';
import { DOWNLOAD_FILENAME, ROOT_CA_PATH } from '@/lib/https-ca';

function makeCtx() {
  return {
    request: new Request('http://localhost/api/https/root-ca'),
  } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.mocked(readFile).mockReset();
});

describe('GET /api/https/root-ca', () => {
  it('serves the CA root as x-x509-ca-cert with an attachment disposition', async () => {
    const pem = Buffer.from('-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');
    vi.mocked(readFile).mockResolvedValue(pem as never);
    const res = await GET(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/x-x509-ca-cert');
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="${DOWNLOAD_FILENAME}"`);
    expect(res.headers.get('Content-Length')).toBe(String(pem.length));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toContain('BEGIN CERTIFICATE');
  });

  it('reads exactly the public root path (never the PKI volume)', async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from('x') as never);
    await GET(makeCtx());
    expect(readFile).toHaveBeenCalledWith(ROOT_CA_PATH);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('returns 404 with guidance until Caddy has generated the CA root', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const res = await GET(makeCtx());
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/--profile web/);
  });

  it('returns 500 (not the missing-CA guidance) on other fs errors', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const res = await GET(makeCtx());
    expect(res.status).toBe(500);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/server logs/);
  });
});
