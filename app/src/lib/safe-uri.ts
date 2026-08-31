/**
 * Safe external URI handling.
 *
 * Chain-controlled metadata (token metadata_uri etc.) must never be rendered
 * directly as an <a href>: React does not sanitize the URL scheme, so a
 * `javascript:` URI becomes a stored XSS sink. URIs are rendered as links
 * only when they parse as https: (or ipfs:, mapped to a gateway); anything
 * else degrades to plain text.
 */

export const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

export function getIpfsGateway(): string {
  const raw = process.env.PUBLIC_IPFS_GATEWAY;
  if (!raw) return DEFAULT_IPFS_GATEWAY;
  return raw.endsWith('/') ? raw : raw + '/';
}

/**
 * Resolve a chain-supplied URI to a safe https: href, or null when the URI
 * must not be rendered as a link (unknown scheme, javascript:, data:, http:,
 * unparseable garbage).
 */
export function safeExternalUri(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol === 'https:') return url.toString();

  if (url.protocol === 'ipfs:') {
    // ipfs://<cid>[/path] → gateway URL. new URL() puts the CID in `host`.
    const cid = url.host || url.pathname.replace(/^\/+/, '');
    if (!cid) return null;
    const path = url.pathname.replace(/^\/+/, '');
    const search = url.search; // preserve query (filename hints etc.)
    return getIpfsGateway() + cid + (path ? '/' + path : '') + search;
  }

  // http: (insecure downgrade), javascript:, data:, vbscript:, anything else
  return null;
}
