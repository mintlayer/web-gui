import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchUsdPrices,
  tickerToPriceId,
  PRICE_CACHE_KEY,
  type UsdPrices,
} from './prices';

type CacheShape = Record<string, string>;

function stubStorage(initial: CacheShape = {}): CacheShape {
  const store: CacheShape = { ...initial };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
  });
  return store;
}

const NOW = 1_000_000_000_000;

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe('tickerToPriceId', () => {
  it('maps known tickers case-insensitively and rejects unknown ones', () => {
    expect(tickerToPriceId('USDC')).toBe('usd-coin');
    expect(tickerToPriceId('ml')).toBe('mintlayer');
    expect(tickerToPriceId('nope')).toBeNull();
  });
});

describe('fetchUsdPrices', () => {
  let store: CacheShape;

  beforeEach(() => {
    vi.restoreAllMocks();
    store = stubStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // @ts-expect-error test cleanup of the stubbed global
    delete globalThis.localStorage;
  });

  it('returns fresh cached prices without any network call', async () => {
    store[PRICE_CACHE_KEY] = JSON.stringify({
      'usd-coin': { usd: 1.0, ts: NOW - 1000 },
    });
    const fetchImpl = vi.fn();
    const prices = await fetchUsdPrices(['usd-coin'], { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW });
    expect(prices).toEqual({ 'usd-coin': 1.0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refetches stale entries and merges with fresh cache', async () => {
    store[PRICE_CACHE_KEY] = JSON.stringify({
      'usd-coin': { usd: 1.0, ts: NOW - 20 * 60_000 },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json({ tether: { usd: 1.0001 } }));
    const prices = await fetchUsdPrices(['usd-coin', 'tether'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(prices['usd-coin']).toBe(1.0);
    expect(prices['tether']).toBe(1.0001);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls[0]?.[0] as URL) ?? '')).toContain('ids=usd-coin%2Ctether');
  });

  it('degrades to stale cache when the API fails', async () => {
    store[PRICE_CACHE_KEY] = JSON.stringify({
      'usd-coin': { usd: 1.0, ts: NOW - 60 * 60_000 },
    });
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const prices = await fetchUsdPrices(['usd-coin'], { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW });
    expect(prices).toEqual({ 'usd-coin': 1.0 });
  });

  it('rejects invalid cache entries (tampered, non-positive, future ts)', async () => {
    store[PRICE_CACHE_KEY] = JSON.stringify({
      'usd-coin': { usd: -5, ts: NOW - 1000 },
      tether: { usd: 'lots', ts: NOW - 1000 },
      dai: { usd: 1.0, ts: NOW + 9999 },
    });
    const fetchImpl = vi.fn().mockResolvedValue(json({}));
    const prices: UsdPrices = await fetchUsdPrices(['usd-coin', 'tether', 'dai'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(prices).toEqual({});
  });

  it('survives missing localStorage entirely', async () => {
    // @ts-expect-error simulate environments without localStorage
    delete globalThis.localStorage;
    const fetchImpl = vi.fn().mockResolvedValue(json({ 'usd-coin': { usd: 1.0 } }));
    const prices = await fetchUsdPrices(['usd-coin'], { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW });
    expect(prices['usd-coin']).toBe(1.0);
  });
});
