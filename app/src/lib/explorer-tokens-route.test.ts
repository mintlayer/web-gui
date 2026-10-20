/**
 * Tests for the /api/explorer-tokens route (kept outside src/pages -
 * colocated tests there compile into phantom endpoints).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GET,
  explorerTokensBase,
  clearExplorerTokensCache,
} from '../pages/api/explorer-tokens';

const MAINNET = 'https://staging.explorer.mintlayer.org';
const TESTNET = 'https://staging.lovelace.explorer.mintlayer.org';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tmltoken1234567890abcdef',
    ticker: 'tst',
    displayName: 'Test Token',
    categories: ['meme'],
    circulatingSupply: '1,000,000',
    decimals: 18,
    verified: true,
    ...overrides,
  };
}

const ENV_KEYS = ['NETWORK', 'EXPLORER_TOKENS_API_BASE'] as const;

/** The route only reads the Request body/none - cast past APIContext. */
function call(req: Request): ReturnType<typeof GET> {
  return GET(req as unknown as Parameters<typeof GET>[0]);
}

function stubEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const k of ENV_KEYS) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
}

let fetchMock: ReturnType<typeof vi.fn>;

describe('explorer-tokens route', () => {
  beforeEach(() => {
    clearExplorerTokensCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    stubEnv({});
    vi.unstubAllGlobals();
  });

  it('maps NETWORK to the fixed explorer hosts', () => {
    expect(explorerTokensBase('mainnet')).toBe(MAINNET);
    expect(explorerTokensBase('testnet')).toBe(TESTNET);
    expect(explorerTokensBase(undefined)).toBe(MAINNET);
    expect(explorerTokensBase('bogus')).toBe(MAINNET);
    process.env.EXPLORER_TOKENS_API_BASE = 'https://explorer.example.org/';
    expect(explorerTokensBase('mainnet')).toBe('https://explorer.example.org');
    process.env.EXPLORER_TOKENS_API_BASE = 'http://insecure.example.org';
    expect(explorerTokensBase('mainnet')).toBeNull();
  });

  it('merges both filters, keeps verified rows only, emits lean rows', async () => {
    stubEnv({ NETWORK: 'mainnet' });
    fetchMock
      .mockResolvedValueOnce(jsonResponse([row(), row({ id: 'raw1', verified: false }), 'junk']))
      .mockResolvedValueOnce(
        jsonResponse([row({ id: 'lock1', ticker: '', categories: Array(10).fill('x') })]),
      );

    const res = await call(new Request('http://localhost/api/explorer-tokens'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tokens: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.tokens).toHaveLength(2);

    const first = body.tokens[0] as Record<string, unknown>;
    expect(first).toEqual({
      tokenId: 'tmltoken1234567890abcdef',
      ticker: 'tst',
      displayName: 'Test Token',
      categories: ['meme'],
      circulatingSupply: '1,000,000',
      decimals: 18,
    });
    // Empty ticker falls back to the first four id characters.
    const second = body.tokens[1] as Record<string, unknown>;
    expect(second.ticker).toBe('LOCK');
    expect((second.categories as unknown[]).length).toBeLessThanOrEqual(8);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${MAINNET}/api/tokens-search?filter=Fixed`);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `${MAINNET}/api/tokens-search?filter=Lockable`,
    );
  });

  it('serves from cache within the TTL without refetching', async () => {
    stubEnv({ NETWORK: 'mainnet' });
    fetchMock
      .mockResolvedValueOnce(jsonResponse([row()]))
      .mockResolvedValueOnce(jsonResponse([]));

    await call(new Request('http://localhost/api/explorer-tokens'));
    await call(new Request('http://localhost/api/explorer-tokens'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects literal null / non-array bodies with 502', async () => {
    stubEnv({ NETWORK: 'mainnet' });
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(null)));

    const res = await call(new Request('http://localhost/api/explorer-tokens'));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it('rejects HTML responses (old-build 404 pages) with 502', async () => {
    stubEnv({ NETWORK: 'mainnet' });
    fetchMock.mockResolvedValue(
      new Response('<html><body>404</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const res = await call(new Request('http://localhost/api/explorer-tokens'));
    expect(res.status).toBe(502);
  });

  it('refuses oversized declared bodies before reading them', async () => {
    stubEnv({ NETWORK: 'mainnet' });
    fetchMock.mockResolvedValue(
      new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) },
      }),
    );

    const res = await call(new Request('http://localhost/api/explorer-tokens'));
    expect(res.status).toBe(502);
  });

  it('refuses chunked bodies that grow past the cap while streaming', async () => {
    stubEnv({ NETWORK: 'mainnet' });
    const big = 'x'.repeat(3 * 1024 * 1024);
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(big, {
          status: 200,
          // Deliberately no content-length header (chunked transfer).
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const res = await call(new Request('http://localhost/api/explorer-tokens'));
    expect(res.status).toBe(502);
  });

  it('shares one upstream refresh across concurrent requests', async () => {
    stubEnv({ NETWORK: 'mainnet' });
    let calls = 0;
    fetchMock.mockImplementation(() => {
      calls += 1;
      return new Promise((resolve) => {
        setTimeout(() => resolve(jsonResponse([])), 20);
      });
    });

    await Promise.all([
      call(new Request('http://localhost/api/explorer-tokens')),
      call(new Request('http://localhost/api/explorer-tokens')),
      call(new Request('http://localhost/api/explorer-tokens')),
    ]);
    // 3 concurrent requests share one refresh = exactly 2 filter fetches.
    expect(calls).toBe(2);
  });

  it('reports network failures as 502', async () => {
    stubEnv({ NETWORK: 'mainnet' });
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const res = await call(new Request('http://localhost/api/explorer-tokens'));
    expect(res.status).toBe(502);
  });

  it('answers 500 when the configured base is invalid', async () => {
    stubEnv({ NETWORK: 'mainnet', EXPLORER_TOKENS_API_BASE: 'not a url' });
    const res = await call(new Request('http://localhost/api/explorer-tokens'));
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
