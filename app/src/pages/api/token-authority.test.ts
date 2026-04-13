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

function makeCtx(addresses?: string) {
  const url = new URL(`http://localhost/api/token-authority${addresses ? `?addresses=${addresses}` : ''}`);
  return {
    request: new Request(url.toString()),
    url,
  } as Parameters<typeof import('@/pages/api/token-authority').GET>[0];
}

describe('GET /api/token-authority', () => {
  it('returns 400 when addresses param is missing', async () => {
    const { GET } = await import('@/pages/api/token-authority');
    const res = await GET(makeCtx());
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false });
  });

  it('returns 400 when addresses is empty string', async () => {
    const { GET } = await import('@/pages/api/token-authority');
    const res = await GET(makeCtx(''));
    expect(res.status).toBe(400);
  });

  it('returns deduplicated token IDs from a single address', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(['tok1', 'tok2']), { status: 200 }),
    );
    const { GET } = await import('@/pages/api/token-authority');
    const res = await GET(makeCtx('addr1'));
    const body = await res.json() as { ok: boolean; result: string[] };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result).toEqual(['tok1', 'tok2']);
  });

  it('deduplicates token IDs across multiple addresses', async () => {
    // Both addresses return overlapping token IDs
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(['tok1', 'tok2']), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(['tok2', 'tok3']), { status: 200 }));
    const { GET } = await import('@/pages/api/token-authority');
    const res = await GET(makeCtx('addr1,addr2'));
    const body = await res.json() as { ok: boolean; result: string[] };
    expect(body.result).toHaveLength(3);
    expect(new Set(body.result)).toEqual(new Set(['tok1', 'tok2', 'tok3']));
  });

  it('treats non-ok upstream responses as empty result for that address', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));
    const { GET } = await import('@/pages/api/token-authority');
    const res = await GET(makeCtx('addr1'));
    const body = await res.json() as { ok: boolean; result: string[] };
    expect(res.status).toBe(200);
    expect(body.result).toEqual([]);
  });

  it('returns 502 on fetch exception', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    const { GET } = await import('@/pages/api/token-authority');
    const res = await GET(makeCtx('addr1'));
    expect(res.status).toBe(502);
  });

  it('trims whitespace from comma-separated addresses', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    const { GET } = await import('@/pages/api/token-authority');
    await GET(makeCtx(' addr1 , addr2 '));
    // Both addresses should have been requested (2 fetch calls)
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const urls = mockFetch.mock.calls.map(c => c[0] as string);
    expect(urls.some(u => u.includes('addr1'))).toBe(true);
    expect(urls.some(u => u.includes('addr2'))).toBe(true);
  });
});
