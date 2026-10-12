/**
 * GET /ipfs/{cid}/{...path} — same-origin IPFS gateway proxy.
 *
 * The bridge SDK rewrites ipfs:// URIs to /ipfs/… so token metadata
 * (JSON) and icons (images) are fetched same-origin: one place to
 * validate, size-cap and cache, and no third-party host sees our
 * visitors' IPs (an issuer-chosen metadata URL would otherwise be a
 * tracking beacon).
 *
 * NOT an open proxy: only a real CID (v0 base58 or v1 base32) with an
 * optional safe subpath is fetchable, and only from the configured
 * gateway host. Responses are capped and content-type filtered.
 */

export const prerender = false;

/** CIDv0 (base58, Qm…) or CIDv1 (base32/b…, lowercase). */
const CID_RE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[dp][a-z2-7]+|[a-z0-9]{59})$/;
/** Safe subpath segments (file names inside the CID). */
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** Metadata docs and icons are small; refuse to buffer more. */
const MAX_BYTES = 2 * 1024 * 1024;

const DEFAULT_GATEWAY = 'https://ipfs.io/ipfs/';

const ALLOWED_TYPES = /^(?:application\/json|application\/octet-stream|image\/[a-z0-9.+-]+|text\/plain)\b/i;

/** Builds the upstream gateway URL; null when the path is not a CID. */
export function upstreamForPath(rawPath: string): string | null {
  const segments = rawPath.split('/').filter((s) => s.length > 0);
  if (segments.length === 0 || segments.length > 4) return null;
  if (segments.some((s) => s === '.' || s === '..')) return null;
  if (!segments.every((s, i) => (i === 0 ? CID_RE.test(s) : SEGMENT_RE.test(s)))) {
    return null;
  }
  const base = (process.env.IPFS_GATEWAY_URL ?? DEFAULT_GATEWAY).replace(/\/+$/, '');
  return `${base}/${segments.join('/')}`;
}

export async function GET(ctx: {
  params: { path?: string | string[] };
}): Promise<Response> {
  const raw = Array.isArray(ctx.params.path)
    ? ctx.params.path.join('/')
    : (ctx.params.path ?? '');
  const upstream = upstreamForPath(raw);
  if (!upstream) {
    return new Response('Not found', { status: 404 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, {
      signal: controller.signal,
      headers: { accept: 'application/json, image/*;q=0.9, text/plain;q=0.5' },
    });
  } catch {
    clearTimeout(timer);
    return new Response('Bad gateway', { status: 502 });
  }
  clearTimeout(timer);

  if (!upstreamRes.ok) {
    return new Response('Not found', { status: upstreamRes.status === 404 ? 404 : 502 });
  }

  const contentType = (upstreamRes.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!ALLOWED_TYPES.test(contentType)) {
    return new Response('Unsupported media type', { status: 415 });
  }

  // Cap the buffered size — a huge file must not exhaust the server.
  const declared = Number(upstreamRes.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return new Response('Too large', { status: 413 });
  }
  const buffer = await upstreamRes.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) {
    return new Response('Too large', { status: 413 });
  }

  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': contentType || 'application/octet-stream',
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}
