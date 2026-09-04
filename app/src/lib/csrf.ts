/**
 * Proxy-aware cross-site request check.
 *
 * Replaces Astro's built-in `security.checkOrigin`, which compares the
 * browser's Origin header against the URL derived from the *socket* —
 * behind a TLS-terminating proxy (caddy) the app sees plain HTTP and every
 * form POST 403s. See astro/dist/core/app/origin-check.js for the original.
 *
 * The expected origin is derived from the standard proxy headers first
 * (X-Forwarded-Proto / X-Forwarded-Host, first value only), falling back to
 * the request's own URL. Semantics mirror Astro's check exactly so no
 * request that previously passed now fails, and vice versa.
 *
 * Deployment assumption: trusting X-Forwarded-* unconditionally is safe only
 * while web-gui is reachable exclusively via loopback or via a proxy that
 * sanitizes inbound X-Forwarded-* (caddy ignores client-supplied values by
 * default). If web-gui is ever exposed directly to an untrusted network,
 * these headers become attacker-controlled and this check must be gated on
 * a trust-proxy signal.
 */

const FORM_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function firstForwarded(value: string | null): string | undefined {
  return value?.split(',')[0]?.trim() || undefined;
}

/** Origin the app should treat as its own, honoring TLS-terminating proxies. */
export function expectedOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto = (
    firstForwarded(request.headers.get('x-forwarded-proto')) ?? url.protocol.replace(/:$/, '')
  ).toLowerCase();
  const host =
    firstForwarded(request.headers.get('x-forwarded-host')) ?? request.headers.get('host') ?? url.host;
  return `${proto}://${host}`;
}

/**
 * True when a state-changing request's Origin does not match the expected
 * origin. Mirrors Astro's built-in semantics:
 * - safe methods never match the check
 * - with a form-like (or absent) Content-Type, a mismatching Origin is fatal
 * - non-form content types (e.g. application/json) are not form submissions
 * - requests without an Origin header are held to the same standard
 */
export function isForbiddenCrossSiteRequest(request: Request): boolean {
  if (SAFE_METHODS.includes(request.method)) {
    return false;
  }
  const isSameOrigin = request.headers.get('origin') === expectedOrigin(request);
  const contentType = request.headers.get('content-type');
  if (contentType === null) {
    return !isSameOrigin;
  }
  const isFormLike = FORM_CONTENT_TYPES.some((t) => contentType.toLowerCase().includes(t));
  return isFormLike && !isSameOrigin;
}
