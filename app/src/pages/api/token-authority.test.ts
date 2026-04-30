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

function makeCtx(addresses?: string[]) {
  const url = new URL('http://localhost/api/token-authority');
  const body = addresses !== undefined ? JSON.stringify({ addresses }) : undefined;
  return {
    request: new Request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
    url,
  } as Parameters<typeof import('@/pages/api/token-authority').POST>[0];
}

describe('POST /api/token-authority', () => {
  it('returns 400 when addresses is missing', async () => {
    const { POST } = await import('@/pages/api/token-authority');
    const res = await POST(makeCtx());
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false });
  });

  it('returns 400 when addresses is empty array', async () => {
    const { POST } = await import('@/pages/api/token-authority');
    const res = await POST(makeCtx([]));
    expect(res.status).toBe(400);
  });

  it('returns deduplicated token IDs from a single address', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(['tok1', 'tok2']), { status: 200 }),
    );
    const { POST } = await import('@/pages/api/token-authority');
    const res = await POST(makeCtx(['addr1']));
    const body = await res.json() as { ok: boolean; result: string[] };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result).toEqual(['tok1', 'tok2']);
  });

  it('deduplicates token IDs across multiple addresses', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(['tok1', 'tok2']), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(['tok2', 'tok3']), { status: 200 }));
    const { POST } = await import('@/pages/api/token-authority');
    const res = await POST(makeCtx(['addr1', 'addr2']));
    const body = await res.json() as { ok: boolean; result: string[] };
    expect(body.result).toHaveLength(3);
    expect(new Set(body.result)).toEqual(new Set(['tok1', 'tok2', 'tok3']));
  });

  it('treats non-ok upstream responses as empty result for that address', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));
    const { POST } = await import('@/pages/api/token-authority');
    const res = await POST(makeCtx(['addr1']));
    const body = await res.json() as { ok: boolean; result: string[] };
    expect(res.status).toBe(200);
    expect(body.result).toEqual([]);
  });

  it('returns 502 on fetch exception', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    const { POST } = await import('@/pages/api/token-authority');
    const res = await POST(makeCtx(['addr1']));
    expect(res.status).toBe(502);
  });

  it('trims whitespace from addresses', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    const { POST } = await import('@/pages/api/token-authority');
    await POST(makeCtx([' addr1 ', ' addr2 ']));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const urls = mockFetch.mock.calls.map(c => c[0] as string);
    expect(urls.some(u => u.includes('addr1'))).toBe(true);
    expect(urls.some(u => u.includes('addr2'))).toBe(true);
  });

  it('returns 400 on invalid JSON body', async () => {
    const url = new URL('http://localhost/api/token-authority');
    const ctx = {
      request: new Request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
      url,
    } as Parameters<typeof import('@/pages/api/token-authority').POST>[0];
    const { POST } = await import('@/pages/api/token-authority');
    const res = await POST(ctx);
    expect(res.status).toBe(400);
  });
});
