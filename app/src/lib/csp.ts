/**
 * Content-Security-Policy builder.
 *
 * The bridge SDK makes browser-side calls to the bridge API (REST plus a
 * `wss://` subscribe feed), the Mintlayer indexer (token metadata) and
 * CoinGecko (USD prices). Those hosts are derived from the same config
 * values the SDK reads (`PUBLIC_BRIDGE_API_URL`,
 * `PUBLIC_MINTLAYER_API_URL`), so the policy follows an operator
 * override instead of silently drifting out of sync.
 *
 * `CSP_CONNECT_EXTRA` (comma-separated origins, e.g.
 * "https://mirror.example,http://localhost:8080") is a strict allowlist
 * escape hatch: entries must look like `scheme://host[:port]` or they
 * are dropped, so a stray value cannot widen the policy into
 * `connect-src *`.
 *
 * Rollout stays report-only by default (see middleware.ts); enforcement
 * still requires the inline-script nonce work.
 */

import { getBridgeApiUrl, getMintlayerApiUrl } from '@/lib/bridge-sdk/config';

/** CoinGecko simple/price endpoint host (prices.ts). */
const COINGECKO_ORIGIN = 'https://api.coingecko.com';

/** Strict origin shape: scheme://host[:port] - no paths, no wildcards. */
const ORIGIN_RE = /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9._-]+(?::\d{1,5})?$/i;

/**
 * Runtime override for the PUBLIC_* base URLs. import.meta.env is
 * inlined at build time, so the middleware (which runs server-side)
 * reads process.env first and falls back to the SDK values - the same
 * defaults, but operators can retarget the policy without a rebuild.
 */
function apiBase(overrideKey: string, fallback: string): string {
  const override = process.env[overrideKey]?.trim();
  return override !== undefined && override !== '' ? override : fallback;
}

/** Extracts the http(s) origin of an API base URL; null when unparseable. */
function originOf(apiUrl: string): string | null {
  try {
    const origin = new URL(apiUrl).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** The websocket twin of an http(s) origin (for the subscribe feed). */
function wsOriginOf(apiUrl: string): string | null {
  try {
    const { protocol, host } = new URL(apiUrl);
    if (protocol === 'https:') return `wss://${host}`;
    if (protocol === 'http:') return `ws://${host}`;
    return null;
  } catch {
    return null;
  }
}

/** Builds the connect-src source list, deduplicated, 'self' first. */
export function connectSources(): string[] {
  // 'self' must stay quoted - a bare `self` is an invalid CSP source and
  // would silently drop same-origin under enforcement.
  const sources = new Set<string>(["'self'", COINGECKO_ORIGIN]);
  const apiUrls = [
    apiBase('PUBLIC_BRIDGE_API_URL', getBridgeApiUrl()),
    apiBase('PUBLIC_MINTLAYER_API_URL', getMintlayerApiUrl()),
  ];
  for (const apiUrl of apiUrls) {
    const origin = originOf(apiUrl);
    if (origin) sources.add(origin);
    const ws = wsOriginOf(apiUrl);
    if (ws) sources.add(ws);
  }
  const extra = process.env.CSP_CONNECT_EXTRA ?? '';
  for (const entry of extra.split(',')) {
    const trimmed = entry.trim();
    if (trimmed !== '' && ORIGIN_RE.test(trimmed)) sources.add(trimmed);
  }
  return [...sources];
}

export function buildCsp(): string {
  return (
    "default-src 'self'; " +
    "img-src 'self' https: data:; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    `connect-src ${connectSources().join(' ')}; ` +
    "font-src 'self' data:; " +
    "frame-src 'self'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'none'; " +
    "form-action 'self'; " +
    "object-src 'none';"
  );
}
