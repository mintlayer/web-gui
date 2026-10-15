import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prefs-db', () => ({
  getPref: vi.fn(),
  setPref: vi.fn(),
}));

import { GET, POST } from '@/pages/api/prefs';
import { getPref, setPref } from '@/lib/prefs-db';

function makeCtx(body?: unknown) {
  return {
    request: new Request('http://localhost/api/prefs', {
      method: body !== undefined ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.mocked(getPref).mockReset();
  vi.mocked(setPref).mockReset();
});

describe('GET /api/prefs', () => {
  it('returns stored favourites', async () => {
    vi.mocked(getPref).mockReturnValue(['tokenA', 'tokenB']);
    const res = await GET(makeCtx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, value: ['tokenA', 'tokenB'] });
  });

  it('drops invalid entries from stored values on read', async () => {
    vi.mocked(getPref).mockReturnValue([
      { tokenId: 'good1', ticker: 'G1' },
      { tokenId: 42 },
      'legacy-string-id',
      null,
      { tokenId: 'good2', ticker: '' },
    ]);
    const res = await GET(makeCtx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.value).toEqual([
      { tokenId: 'good1', ticker: 'G1' },
      'legacy-string-id',
    ]);
  });

  it('returns empty array when nothing stored', async () => {
    vi.mocked(getPref).mockReturnValue(null);
    const res = await GET(makeCtx());
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, value: [] });
  });

  it('returns 500 on getPref error', async () => {
    vi.mocked(getPref).mockImplementation(() => { throw new Error('db error'); });
    const res = await GET(makeCtx());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});

describe('POST /api/prefs', () => {
  it('saves an array of tokens', async () => {
    const res = await POST(makeCtx(['tok1', 'tok2']));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(setPref).toHaveBeenCalledWith('ml_favourite_tokens', ['tok1', 'tok2']);
  });

  it('returns 400 when body is not an array', async () => {
    const res = await POST(makeCtx({ not: 'array' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('returns 500 on setPref error', async () => {
    vi.mocked(setPref).mockImplementation(() => { throw new Error('db error'); });
    const res = await POST(makeCtx(['tok']));
    expect(res.status).toBe(500);
  });

  it('returns 500 on invalid JSON body', async () => {
    const ctx = {
      request: new Request('http://localhost/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json{{{',
      }),
    } as Parameters<typeof POST>[0];
    const res = await POST(ctx);
    expect(res.status).toBe(500);
  });

  it('accepts {tokenId, ticker} entries and passes them through', async () => {
    const entries = [{ tokenId: 'tmlabc123', ticker: 'ABC' }];
    const res = await POST(makeCtx(entries));
    expect(res.status).toBe(200);
    expect(setPref).toHaveBeenCalledWith('ml_favourite_tokens', entries);
  });

  it('rejects malformed entries with 400', async () => {
    for (const bad of [[42], [{ tokenId: 'x' }], [{ ticker: 'NOTOKENID' }], [{ tokenId: 'ok', ticker: '' }], [{ tokenId: 'ok', ticker: 9 }]]) {
      const res = await POST(makeCtx(bad));
      expect(res.status).toBe(400);
    }
    expect(setPref).not.toHaveBeenCalled();
  });

  it('rejects arrays beyond the cap with 400', async () => {
    const big = Array.from({ length: 1001 }, (_, i) => `token${i}`);
    const res = await POST(makeCtx(big));
    expect(res.status).toBe(400);
    expect(setPref).not.toHaveBeenCalled();
  });

  it('rejects absurd declared body sizes with 413 before parsing', async () => {
    const ctx = {
      request: new Request('http://localhost/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '99999999' },
        body: '[]',
      }),
    } as Parameters<typeof POST>[0];
    const res = await POST(ctx);
    expect(res.status).toBe(413);
  });
});
