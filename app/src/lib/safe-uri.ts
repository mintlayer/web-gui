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

/**
 * Resolve a chain-supplied URI to a safe <img src>, or null when it must not
 * be rendered as an image.
 *
 * Unlike links, images cannot execute scripts — but they DO fetch the remote
 * resource, so an unfiltered chain-controlled icon_uri/metadata_uri would let
 * a token issuer turn every wallet that lists the token into a tracking
 * beacon (IP + user-agent + view timing) for arbitrary schemes. Only https:
 * (plus ipfs: mapped to the gateway) and self-contained data:image/ URIs are
 * allowed; everything else degrades to the placeholder.
 */
export function safeImageUri(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // data:image/... payloads never touch the network; scripts inside an <img>
  // context do not execute. Anything but a strict image data URI is rejected.
  if (/^data:image\/[a-z0-9.!#$&^+\-_.]+[;,]/i.test(trimmed)) return trimmed;
  return safeExternalUri(trimmed);
}
