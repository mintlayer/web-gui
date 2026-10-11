import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getIndexerCapabilities,
  resetCapabilitiesCacheForTests,
} from './indexer-capabilities';

function mockFetch(
  statusByPath: Record<string, number>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = statusByPath[url];
    const response = new Response(null, { status: path ?? 404 });
    Object.defineProperty(response, 'body', { value: null });
    return response;
  });
}

describe('getIndexerCapabilities', () => {
  beforeEach(() => {
    resetCapabilitiesCacheForTests();
    vi.stubGlobal('fetch', mockFetch({}));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports both capabilities on a 1.4.1 indexer', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        'http://api-web-server:3000/api/v2/mempool/transactions': 200,
        'http://api-web-server:3000/api/v2/stream': 200,
      }),
    );
    await expect(getIndexerCapabilities(true)).resolves.toEqual({
      mempoolApi: true,
      stream: true,
    });
  });

  it('reports both capabilities absent on a pre-1.4.1 indexer', async () => {
    await expect(getIndexerCapabilities(true)).resolves.toEqual({
      mempoolApi: false,
      stream: false,
    });
  });

  it('treats probe failures as absent capabilities', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connection refused');
    }));
    await expect(getIndexerCapabilities(true)).resolves.toEqual({
      mempoolApi: false,
      stream: false,
    });
  });

  it('probes each endpoint independently', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        'http://api-web-server:3000/api/v2/mempool/transactions': 200,
      }),
    );
    await expect(getIndexerCapabilities(true)).resolves.toEqual({
      mempoolApi: true,
      stream: false,
    });
  });

  it('caches the result within the TTL', async () => {
    const fetchMock = mockFetch({
      'http://api-web-server:3000/api/v2/mempool/transactions': 200,
      'http://api-web-server:3000/api/v2/stream': 200,
    });
    vi.stubGlobal('fetch', fetchMock);
    await getIndexerCapabilities(true);
    await getIndexerCapabilities();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-probes when force=true', async () => {
    const fetchMock = mockFetch({
      'http://api-web-server:3000/api/v2/mempool/transactions': 200,
      'http://api-web-server:3000/api/v2/stream': 200,
    });
    vi.stubGlobal('fetch', fetchMock);
    await getIndexerCapabilities(true);
    await getIndexerCapabilities(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
