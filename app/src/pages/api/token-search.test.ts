import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  delete process.env.INDEXER_URL;
});

afterEach(() => {
  mockFetch.mockReset();
  vi.unstubAllGlobals();
  delete process.env.INDEXER_URL;
});

function makeCtx(ticker?: string) {
  const url = new URL(`http://localhost/api/token-search${ticker ? `?ticker=${ticker}` : ''}`);
  return {
    request: new Request(url.toString()),
    url,
  } as Parameters<typeof import('@/pages/api/token-search').GET>[0];
}

describe('GET /api/token-search', () => {
  it('returns 400 when ticker param is missing', async () => {
    const { GET } = await import('@/pages/api/token-search');
    const res = await GET(makeCtx());
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false });
  });

  it('returns 400 when ticker is empty string', async () => {
    const { GET } = await import('@/pages/api/token-search');
    const res = await GET(makeCtx(''));
    expect(res.status).toBe(400);
  });

  it('encodes the ticker in the upstream URL', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(['tid1']), { status: 200 }),
    );
    const { GET } = await import('@/pages/api/token-search');
    await GET(makeCtx('ML TOKEN'));
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('ML%20TOKEN');
  });

  it('returns {ok: true, result} on indexer success', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(['tid1', 'tid2']), { status: 200 }),
    );
    const { GET } = await import('@/pages/api/token-search');
    const res = await GET(makeCtx('ML'));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, result: ['tid1', 'tid2'] });
  });

  it('returns 502 when indexer returns non-ok status', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));
    const { GET } = await import('@/pages/api/token-search');
    const res = await GET(makeCtx('ML'));
    expect(res.status).toBe(502);
  });

  it('returns 502 on fetch exception', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { GET } = await import('@/pages/api/token-search');
    const res = await GET(makeCtx('ML'));
    expect(res.status).toBe(502);
  });
});
