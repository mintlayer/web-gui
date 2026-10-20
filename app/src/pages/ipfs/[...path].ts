/**
 * GET /ipfs/{cid}/{...path} - same-origin IPFS gateway proxy.
 *
 * The bridge SDK rewrites ipfs:// URIs to /ipfs/… so token metadata
 * (JSON) and icons (images) are fetched same-origin: one place to
 * validate, size-cap and cache, and no third-party host sees our
 * visitors' IPs (an issuer-chosen metadata URL would otherwise be a
 * tracking beacon).
 *
 * This mirrors the bridge-frontend production proxy (functions/ipfs and
 * src/app/ipfs): public gateways fail over instead of taking every
 * token icon down with one provider (ipfs.io/dweb.link had multi-hour
 * outages in 2026-09/10). CIDs are content-addressed, so successes are
 * cached aggressively and never need invalidation; total failures are
 * not cached so a broken page cannot pin repeated upstream fetches.
 *
 * NOT an open proxy: only a real CID (v0 base58 or v1 base32) with an
 * optional safe subpath is fetchable, and only from the configured
 * gateway hosts. Redirects are followed only to a subdomain of the
 * same gateway (the CIDv1 → subdomain-gateway pattern) - never to an
 * arbitrary host. Responses are size-capped and content-type filtered.
 */

export const prerender = false;

// Happy-eyeballs per-address connect timeout. The default (250 ms) is
// shorter than the real RTT to the CDN edge from some networks (~300 ms),
// so Node intermittently aborts connects that would have succeeded -
// surfacing as connect ETIMEDOUT after ~2×250 ms and, through this
// proxy, flaky 502s and missing token icons. Widen the window; dead
// addresses still fall through to the next family.
import net from 'node:net';
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
  net.setDefaultAutoSelectFamilyAttemptTimeout(1000);
}

/** CIDv0 (base58, Qm…) or CIDv1 (base32, bafy…/bafkrei…, lowercase). */
const CID_RE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{8,})$/;
/** Safe subpath segments (file names inside the CID). */
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** Metadata docs and icons are small; refuse to buffer more. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Per-gateway budget; worst case (all hang) ≈ count × this. */
const GATEWAY_TIMEOUT_MS = 12_000;

const DEFAULT_GATEWAYS = [
  // The project's own production proxy only (R2-backed, same
  // content-addressed paths, measured 200 in <1s). Public IPFS gateways
  // are unreliable from residential networks (429 "service worker only",
  // multi-second hangs) and we don't fall back to them by default. The
  // list stays env-overridable (IPFS_GATEWAY_URLS) and the failover loop
  // stays in place for operator-added mirrors.
  'https://bridge.mintlayer.org/ipfs',
];

// SVG is excluded: same-origin SVG can carry script (self-XSS via a
// crafted issuer CID). Everything else is inert behind nosniff + CSP.
const ALLOWED_TYPES =
  /^(?:application\/json|application\/octet-stream|image\/(?!svg)[a-z0-9.+-]+|text\/plain)\b/i;

/** Applied to every proxied response - the body is never trusted. */
const RESPONSE_CSP = "default-src 'none'; sandbox";

function configuredGateways(): string[] {
  const override = process.env.IPFS_GATEWAY_URLS ?? process.env.IPFS_GATEWAY_URL;
  if (!override) return DEFAULT_GATEWAYS;
  const list = override
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => /^https?:\/\/[a-z0-9.-]+/.test(s));
  return list.length > 0 ? list : DEFAULT_GATEWAYS;
}

/** Builds the candidate upstream URLs; empty when the path is not a CID. */
export function gatewaysForPath(rawPath: string): string[] {
  const segments = rawPath.split('/').filter((s) => s.length > 0);
  if (segments.length === 0 || segments.length > 4) return [];
  if (segments.some((s) => s === '.' || s === '..')) return [];
  if (!segments.every((s, i) => (i === 0 ? CID_RE.test(s) : SEGMENT_RE.test(s)))) {
    return [];
  }
  return configuredGateways().map((base) => `${base}/${segments.join('/')}`);
}

/** Single-gateway view kept for the validation tests. */
export function upstreamForPath(rawPath: string): string | null {
  return gatewaysForPath(rawPath)[0] ?? null;
}

/** True when location is a subdomain of the gateway's own host. */
function isSameSite(gatewayUrl: string, location: string): boolean {
  try {
    const gatewayHost = new URL(gatewayUrl).hostname;
    const target = new URL(location, gatewayUrl);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
    return target.hostname === gatewayHost || target.hostname.endsWith(`.${gatewayHost}`);
  } catch {
    return false;
  }
}

function errorResponse(message: string, status: number): Response {
  // Failures are NOT cacheable - a cold, broken path must not get
  // pinned by a browser or intermediate cache.
  return new Response(message, { status, headers: { 'cache-control': 'no-store' } });
}

/** Reads a response body through a hard byte cap. Null when over. */
async function readCapped(res: Response): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

export async function GET(ctx: {
  params: { path?: string | string[] };
}): Promise<Response> {
  const raw = Array.isArray(ctx.params.path)
    ? ctx.params.path.join('/')
    : (ctx.params.path ?? '');
  const candidates = gatewaysForPath(raw);
  if (candidates.length === 0) {
    return errorResponse('Not found', 404);
  }

  let lastStatus = 502;
  for (const upstream of candidates) {
    // Cold connects from small containers to the proxy intermittently
    // fail at connect time (ETIMEDOUT/AggregateError well under the
    // per-gateway budget) and succeed on an immediate retry - the
    // browser-visible symptom was missing token icons. Retry the same
    // gateway once on a network-level throw; HTTP statuses are never
    // retried (they are answers, not accidents).
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
      let upstreamRes: Response;
      try {
        // Redirects are handled manually: the CID allowlist gates hop 1,
        // so only a same-site redirect (CIDv1 → subdomain gateway) is
        // followed - never a bounce to an arbitrary host.
        upstreamRes = await fetch(upstream, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: 'application/json, image/*;q=0.9, text/plain;q=0.5' },
        });
      } catch {
        clearTimeout(timer);
        lastStatus = 502;
        continue; // network accident - retry this gateway once
      }

      if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
        const location = upstreamRes.headers.get('location') ?? '';
        // Timer stays armed - both hops share the per-gateway budget.
        if (isSameSite(upstream, location)) {
          try {
            upstreamRes = await fetch(location, {
              redirect: 'error',
              signal: controller.signal,
              headers: { accept: 'application/json, image/*;q=0.9, text/plain;q=0.5' },
            });
          } catch {
            clearTimeout(timer);
            lastStatus = 502;
            continue;
          }
        } else {
          clearTimeout(timer);
          lastStatus = 502;
          break; // foreign redirect - this gateway misbehaves, next one
        }
      }

      if (upstreamRes.status !== 200) {
        clearTimeout(timer);
        lastStatus = upstreamRes.status === 404 ? 404 : 502;
        break; // an HTTP answer - next gateway, not a retry
      }

      // Honour an honest content-length before reading anything.
      const declaredLength = Number(upstreamRes.headers.get('content-length') ?? '');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
        clearTimeout(timer);
        return errorResponse('Too large', 413);
      }

      const contentType = (upstreamRes.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim();
      if (!ALLOWED_TYPES.test(contentType)) {
        clearTimeout(timer);
        // Fail fast: content-type is a property of the CID content, not
        // of the gateway - another gateway would serve the same bytes.
        return errorResponse('Unsupported media type', 415);
      }

      try {
        const buffer = await readCapped(upstreamRes);
        if (buffer === null) {
          return errorResponse('Too large', 413);
        }
        return new Response(buffer.buffer as ArrayBuffer, {
          status: 200,
          headers: {
            'content-type': contentType || 'application/octet-stream',
            // Content-addressed: the bytes for a CID can never change.
            'cache-control': 'public, max-age=2592000, immutable',
            'x-content-type-options': 'nosniff',
            'content-security-policy': RESPONSE_CSP,
            // A poisoned/buggy gateway caching wrong bytes is diagnosable
            // with one curl.
            'x-ipfs-gateway': new URL(upstream).host,
          },
        });
      } catch {
        lastStatus = 502;
        continue;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return errorResponse('Not found', lastStatus);
}
