import { getCoingeckoApiKey } from './config';
import { apiRequest } from './http';
import type { FetchLike } from './http';

/**
 * USD market data for the bridgeable tickers (CoinGecko simple/price).
 * Strictly display-only: a missing or wrong price must never affect
 * amounts - the UI simply hides the $ line when no price is known.
 */

const CG_SIMPLE_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price';

/** localStorage cache - repeat visits skip the round trip entirely. */
export const PRICE_CACHE_KEY = 'ml_usd_price_cache';
/** Public-api friendly: one batched call at most every 10 minutes. */
const PRICE_TTL_MS = 10 * 60_000;

/** CoinGecko ids for the known bridgeable tickers (mainnet set). */
export const PRICE_ID_BY_TICKER: Record<string, string> = {
  ml: 'mintlayer',
  usdc: 'usd-coin',
  usdt: 'tether',
  dai: 'dai',
  weth: 'weth',
  wbtc: 'wrapped-bitcoin',
  wsteth: 'wrapped-steth',
  pepe: 'pepe',
  shib: 'shiba-inu',
  aave: 'aave',
  comp: 'compound-governance-token',
  crv: 'curve-dao-token',
  ldo: 'lido-dao',
  link: 'chainlink',
  ondo: 'ondo-finance',
  uni: 'uniswap',
};

export const tickerToPriceId = (ticker: string): string | null =>
  PRICE_ID_BY_TICKER[ticker.toLowerCase()] ?? null;

export interface UsdPrices {
  [id: string]: number;
}

interface CachedPrice {
  usd: number;
  ts: number;
}

type PriceCache = Record<string, CachedPrice>;

const isFinitePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Validates a raw cache/API entry; null when anything is off. */
const asCachedPrice = (entry: unknown, now: number): CachedPrice | null => {
  if (typeof entry !== 'object' || entry === null) return null;
  const candidate = entry as { usd?: unknown; ts?: unknown };
  if (!isFinitePositive(candidate.usd)) return null;
  if (
    typeof candidate.ts !== 'number' ||
    !Number.isFinite(candidate.ts) ||
    candidate.ts > now
  ) {
    return null;
  }
  return { usd: candidate.usd, ts: candidate.ts };
};

// The cache holds previously-fetched prices, but localStorage is
// user-writable - every entry is re-validated on read so tampering can
// at worst distort a display-only dollar figure.
const readCache = (now: number): PriceCache => {
  try {
    const raw = JSON.parse(
      localStorage.getItem(PRICE_CACHE_KEY) ?? '{}',
    ) as unknown;
    if (typeof raw !== 'object' || raw === null) return {};
    const cache: PriceCache = {};
    Object.entries(raw as Record<string, unknown>).forEach(([id, entry]) => {
      const valid = asCachedPrice(entry, now);
      if (valid) cache[id] = valid;
    });
    return cache;
  } catch {
    return {};
  }
};

const writeCache = (cache: PriceCache): void => {
  try {
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage full/unavailable - prices re-fetch next time */
  }
};

/**
 * Resolves USD prices for the given CoinGecko ids, using the localStorage
 * cache first (fresh entries skip the network entirely; stale entries are
 * returned immediately and refreshed in the background - a failed fetch
 * degrades to the stale figure instead of hiding the $ line).
 */
export async function fetchUsdPrices(
  ids: string[],
  deps: { fetchImpl?: FetchLike; now?: () => number; apiKey?: string } = {},
): Promise<UsdPrices> {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const apiKey = deps.apiKey ?? getCoingeckoApiKey();

  const nowMs = now();
  const cache = readCache(nowMs);
  const prices: UsdPrices = {};
  const missing: string[] = [];
  ids.forEach((id) => {
    const hit = cache[id];
    if (hit) prices[id] = hit.usd;
    if (!hit || nowMs - hit.ts >= PRICE_TTL_MS) missing.push(id);
  });
  if (missing.length === 0) return prices;

  try {
    const url = `${CG_SIMPLE_PRICE_URL}?ids=${encodeURIComponent(
      missing.join(','),
    )}&vs_currencies=usd`;
    const raw = await apiRequest<unknown>(
      url,
      apiKey ? { headers: { 'x-cg-demo-api-key': apiKey } } : {},
      fetchImpl,
    );
    if (typeof raw !== 'object' || raw === null) return prices;

    const nextCache: PriceCache = Object.create(null);
    Object.assign(nextCache, cache);
    Object.entries(raw as Record<string, unknown>).forEach(([id, entry]) => {
      const usd =
        missing.includes(id) && typeof entry === 'object' && entry !== null
          ? (entry as { usd?: unknown }).usd
          : undefined;
      if (isFinitePositive(usd)) {
        prices[id] = usd;
        nextCache[id] = { usd, ts: nowMs };
      }
    });
    writeCache(nextCache);
  } catch {
    /* offline/rate-limited - stale prices (if any) stay in `prices` */
  }
  return prices;
}
