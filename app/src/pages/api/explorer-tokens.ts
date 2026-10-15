/**
 * GET /api/explorer-tokens — verified token list from the Mintlayer
 * explorer's token API.
 *
 * Proxied server-side on purpose: the explorer hosts stay out of the
 * browser CSP connect-src allowlist, the visitor's IP never reaches the
 * explorer, and the response is validated once here instead of in every
 * client. Only the fixed hosts below are fetchable — no user-supplied
 * URLs, so this is not an open proxy.
 *
 * The staging builds predate the `verified` query param (it returns the
 * JSON literal `null` there), so the route always fetches the two supply
 * filters and keeps only rows with `verified === true` — identical
 * behavior on old and new explorer builds. Results are cached briefly
 * in-memory to respect the explorer's polling etiquette (≤1 req/10s).
 *
 * Row note: `circulatingSupply` is a display string (custody-adjusted) —
 * it is passed through untouched, never parsed.
 */

import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';

/** Per-fetch budget; two fetches per refresh, worst case 2× this. */
const UPSTREAM_TIMEOUT_MS = 12_000;
/** ~7k rows of headroom — larger answers are refused, not truncated. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Explorer etiquette: don't poll harder than ~1 req/10s. */
const CACHE_TTL_MS = 60_000;
/** Bound for a single category string. */
const MAX_CATEGORY_LENGTH = 32;

const HOSTS: Record<string, string> = {
  mainnet: 'https://staging.explorer.mintlayer.org',
  testnet: 'https://staging.lovelace.explorer.mintlayer.org',
};

export function explorerTokensBase(network?: string): string | null {
  const override = process.env.EXPLORER_TOKENS_API_BASE;
  if (override !== undefined && override !== '') {
    const trimmed = override.replace(/\/+$/, '');
    return /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(trimmed) ? trimmed : null;
  }
  const host = HOSTS[(network ?? 'mainnet').toLowerCase()] ?? HOSTS['mainnet'];
  return host ?? null;
}

export interface ExplorerTokenRow {
  tokenId: string;
  ticker: string;
  displayName: string | null;
  categories: string[];
  circulatingSupply: string;
  decimals: number;
}

/** Validates one raw API row; null when anything is off (fail closed). */
function asRow(raw: unknown): ExplorerTokenRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 128) return null;
  if (r.verified !== true) return null;
  const ticker =
    typeof r.ticker === 'string' && r.ticker.length > 0
      ? r.ticker.slice(0, 12)
      : r.id.slice(0, 4).toUpperCase();
  const displayName =
    typeof r.displayName === 'string' && r.displayName.length > 0
      ? r.displayName.slice(0, 120)
      : null;
  const categories = Array.isArray(r.categories)
    ? r.categories
        .filter((c): c is string => typeof c === 'string' && c.length > 0)
        .slice(0, 8)
        .map((c) => c.slice(0, MAX_CATEGORY_LENGTH))
    : [];
  const circulatingSupply = typeof r.circulatingSupply === 'string' ? r.circulatingSupply : '0';
  const decimals =
    typeof r.decimals === 'number' && Number.isInteger(r.decimals) && r.decimals >= 0 && r.decimals <= 36
      ? r.decimals
      : 0;
  return { tokenId: r.id, ticker, displayName, categories, circulatingSupply, decimals };
}

/** Reads the body with a hard byte cap; null when the cap is exceeded. */
async function readCapped(res: Response, cap: number): Promise<string | null> {
  if (res.body === null) return null;
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > cap) {
        void reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return null;
  }
  return text;
}

/** Fetches one supply-filter list; returns rows or null on failure. */
async function fetchList(base: string, filter: string): Promise<ExplorerTokenRow[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/api/tokens-search?filter=${encodeURIComponent(filter)}`, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
  } catch {
    clearTimeout(timer);
    return null;
  }
  clearTimeout(timer);

  if (res.status !== 200) return null;
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  if (contentType !== 'application/json') return null;
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null;

  // Streamed read with a hard cap — chunked responses without a
  // content-length header can't blow the heap.
  const text = await readCapped(res, MAX_RESPONSE_BYTES);
  if (text === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  // Old builds answer a param-less/unknown-param request with `null`.
  if (!Array.isArray(parsed)) return null;
  return parsed
    .map(asRow)
    .filter((row): row is ExplorerTokenRow => row !== null);
}

let cache: { at: number; rows: ExplorerTokenRow[] } | null = null;
let inFlight: Promise<ExplorerTokenRow[] | null> | null = null;

/** Fetches both filter lists, merged by token id. */
function fetchMergedRows(base: string): Promise<ExplorerTokenRow[] | null> {
  return Promise.all([fetchList(base, 'Fixed'), fetchList(base, 'Lockable')]).then(
    ([fixed, lockable]) => {
      if (fixed === null || lockable === null) return null;
      const byId = new Map<string, ExplorerTokenRow>();
      for (const row of [...fixed, ...lockable]) byId.set(row.tokenId, row);
      return [...byId.values()];
    },
  );
}

/** Test hook: clears the module-level cache. */
export function clearExplorerTokensCache(): void {
  cache = null;
}

export const GET: APIRoute = async () => {
  const base = explorerTokensBase(process.env.NETWORK);
  if (base === null) {
    return json({ ok: false, error: 'Explorer token API is not configured' }, 500);
  }

  if (cache !== null && Date.now() - cache.at < CACHE_TTL_MS) {
    return json({ ok: true, tokens: cache.rows });
  }

  // Share one upstream refresh across concurrent requests (stampede
  // guard); the TTL is stamped after completion, not at fetch start.
  if (inFlight === null) {
    inFlight = fetchMergedRows(base).finally(() => {
      inFlight = null;
    });
  }
  const rows = await inFlight;
  if (rows === null) {
    return json({ ok: false, error: 'Token list is unavailable' }, 502);
  }

  cache = { at: Date.now(), rows };
  return json({ ok: true, tokens: rows });
};
