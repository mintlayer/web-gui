import { describe, it, expect, vi, afterEach } from 'vitest';
import { GET, upstreamForPath } from './[...path]';

const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const CID_V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

function ctx(path: string) {
  return { params: { path } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('upstreamForPath', () => {
  it('accepts a CID with an optional subpath', () => {
    expect(upstreamForPath(CID_V0)).toBe(`${'https://ipfs.io/ipfs'}/${CID_V0}`);
    expect(upstreamForPath(`${CID_V1}/metadata.json`)).toBe(
      `https://ipfs.io/ipfs/${CID_V1}/metadata.json`,
    );
  });

  it('rejects non-CID paths and traversal', () => {
    expect(upstreamForPath('')).toBe(null);
    expect(upstreamForPath('../etc/passwd')).toBe(null);
    expect(upstreamForPath(`${CID_V0}/../../secret`)).toBe(null);
    expect(upstreamForPath('https://evil.example')).toBe(null);
    expect(upstreamForPath(`${CID_V0}/${'x'.repeat(200)}`)).toBe(null);
  });
});

describe('GET /ipfs/[...path]', () => {
  it('404s without a valid CID', async () => {
    const res = await GET(ctx('not-a-cid'));
    expect(res.status).toBe(404);
  });

  it('proxies JSON from the gateway with caching headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('{"name":"mlPEPE"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ) as unknown as typeof fetch,
    );
    const res = await GET(ctx(CID_V0));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("sandbox");
    expect(await res.text()).toBe('{"name":"mlPEPE"}');
    expect(vi.mocked(fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      `https://ipfs.io/ipfs/${CID_V0}`,
    );
    // Redirects are refused — only hop 1 is CID-gated.
    expect(
      (vi.mocked(fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit)
        .redirect,
    ).toBe('error');
  });

  it('refuses svg — same-origin svg can carry script', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<svg onload="alert(1)"></svg>', {
          status: 200,
          headers: { 'content-type': 'image/svg+xml' },
        }),
      ) as unknown as typeof fetch,
    );
    expect((await GET(ctx(CID_V0))).status).toBe(415);
  });

  it('caps streamed bodies that lie about their size', async () => {
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024).fill(120));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(big, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ) as unknown as typeof fetch,
    );
    expect((await GET(ctx(CID_V0))).status).toBe(413);
  });

  it('rejects disallowed content types', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ) as unknown as typeof fetch,
    );
    const res = await GET(ctx(CID_V0));
    expect(res.status).toBe(415);
  });

  it('enforces the size cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('x', {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(99 * 1024 * 1024) },
        }),
      ) as unknown as typeof fetch,
    );
    const res = await GET(ctx(CID_V0));
    expect(res.status).toBe(413);
  });

  it('maps upstream failure to 502 and fetch errors to 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    );
    expect((await GET(ctx(CID_V0))).status).toBe(502);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    );
    expect((await GET(ctx(CID_V0))).status).toBe(502);
  });

  it('honours the IPFS_GATEWAY_URL override', async () => {
    vi.stubEnv('IPFS_GATEWAY_URL', 'https://gateway.example/ipfs/');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ) as unknown as typeof fetch,
    );
    await GET(ctx(CID_V0));
    expect(vi.mocked(fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      `https://gateway.example/ipfs/${CID_V0}`,
    );
  });
});
