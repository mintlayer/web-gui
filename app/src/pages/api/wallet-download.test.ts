import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:fs/promises so we don't touch the real filesystem
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { GET } from '@/pages/api/wallet-download';
import { readFile } from 'node:fs/promises';

function makeCtx() {
  return {
    request: new Request('http://localhost/api/wallet-download'),
  } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.mocked(readFile).mockReset();
});

describe('GET /api/wallet-download', () => {
  it('returns the wallet file as an octet-stream', async () => {
    const data = Buffer.from('wallet-data');
    vi.mocked(readFile).mockResolvedValue(data as never);
    const res = await GET(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Content-Disposition')).toContain('.backup');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets Content-Length to the file size', async () => {
    const data = Buffer.from('12345');
    vi.mocked(readFile).mockResolvedValue(data as never);
    const res = await GET(makeCtx());
    expect(res.headers.get('Content-Length')).toBe('5');
  });

  it('returns 404 when wallet file is not found', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const res = await GET(makeCtx());
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain('not found');
  });
});
