import '@/lib/settings-migration';
import '@/lib/telegram-bot';
import { defineMiddleware } from 'astro:middleware';
import {
  verifySessionToken,
  generateSessionToken,
  makeSessionCookieHeader,
  SESSION_COOKIE_NAME,
} from '@/lib/auth';
import { getPref } from '@/lib/prefs-db';
import { isForbiddenCrossSiteRequest } from '@/lib/csrf';

const PUBLIC_PATHS = new Set([
  '/login',
  // '/api/login' removed: the route does not exist (login POSTs to /login) and
  // leaving it public only widens the unauthenticated surface for no reason.
  '/api/passkey/auth-options',
  '/api/passkey/auth-verify',
]);
const PUBLIC_PREFIXES = ['/_astro/', '/favicon', '/_image'];

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // strict-origin-when-cross-origin (the browser default) rather than
  // no-referrer: Chrome 151+ elides the Origin header (sends `Origin: null`)
  // on form POSTs when the referrer policy strips referrers entirely, which
  // Astro's same-origin CSRF check then rejects with 403. Cross-origin
  // requests still carry only the origin - no path or query.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/**
 * Content-Security-Policy, rolled out report-only first.
 *
 * Enforcement roadmap: replace script-src 'unsafe-inline' with per-request
 * nonces (Astro inline scripts + is:inline blocks) before switching the
 * header to enforcing Content-Security-Policy. The plugin page renders
 * plugin content inside a sandboxed iframe (opaque origin), so the same
 * policy covers it without frame exemptions.
 */
const CSP_REPORT_ONLY =
  "default-src 'self'; " +
  "img-src 'self' https: data:; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; " +
  "font-src 'self' data:; " +
  "frame-src 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'none'; " +
  "form-action 'self'; " +
  "object-src 'none';";

const CSP_ENABLED = process.env.CSP_ENABLED === 'true';

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = new URL(context.request.url);

  // Cross-site form protection, proxy-aware replacement for Astro's built-in
  // security.checkOrigin (disabled in astro.config.mjs): that check derives
  // the URL scheme from the socket, so behind the TLS-terminating caddy
  // gateway every form POST 403'd. Same pipeline coverage as the built-in
  // check (all routes, incl. /api/*). See lib/csrf.ts.
  if (isForbiddenCrossSiteRequest(context.request)) {
    const forbidden = new Response(
      `Cross-site ${context.request.method} form submissions are forbidden`,
      { status: 403 },
    );
    applySecurityHeaders(forbidden);
    return forbidden;
  }

  if (PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    const response = await next();
    applySecurityHeaders(response);
    return response;
  }

  const cookieHeader = context.request.headers.get('cookie') ?? '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
  const token = match?.[1] ?? '';

  const sessionVersion = getPref<number>('auth.session_version') ?? 0;
  if (!verifySessionToken(token, sessionVersion)) {
    const nextParam =
      pathname !== '/' && !pathname.startsWith('/api/')
        ? `?next=${encodeURIComponent(pathname)}`
        : '';
    return new Response(null, {
      status: 302,
      headers: { Location: `/login${nextParam}` },
    });
  }

  const response = await next();

  const contentType = response.headers.get('content-type') ?? '';
  const alreadySetsCookie = response.headers.has('Set-Cookie');
  // Rolling refresh: re-issue the token on every response so it never ages
  // out mid-session. The version is baked into the token we just verified;
  // a refreshed stale-version token only survives until the next request's
  // version check, so a version bump still invalidates the session cleanly.
  if (!contentType.includes('text/event-stream') && !alreadySetsCookie) {
    const newToken = generateSessionToken(sessionVersion);
    response.headers.set('Set-Cookie', makeSessionCookieHeader(newToken));
  }

  if (!contentType.includes('text/event-stream')) {
    applySecurityHeaders(response);
  }

  return response;
});

function applySecurityHeaders(response: Response): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!response.headers.has(key)) {
      response.headers.set(key, value);
    }
  }
  // CSP: report-only by default; opt into enforcement with CSP_ENABLED=true.
  if (CSP_ENABLED) {
    if (!response.headers.has('Content-Security-Policy')) {
      response.headers.set('Content-Security-Policy', CSP_REPORT_ONLY);
    }
  } else if (!response.headers.has('Content-Security-Policy-Report-Only')) {
    response.headers.set('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY);
  }
}
