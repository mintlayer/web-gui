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
});
