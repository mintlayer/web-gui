import '@/lib/settings-migration';
import '@/lib/telegram-bot';
import { defineMiddleware } from 'astro:middleware';
import {
  verifySessionToken,
  generateSessionToken,
  makeSessionCookieHeader,
  SESSION_COOKIE_NAME,
} from '@/lib/auth';

// Paths that do not require authentication
const PUBLIC_PATHS = new Set([
  '/login',
  '/api/login',
  '/api/passkey/auth-options',
  '/api/passkey/auth-verify',
]);
const PUBLIC_PREFIXES = ['/_astro/', '/favicon', '/_image'];

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = new URL(context.request.url);

  // Pass through public paths and static assets
  if (PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return next();
  }

  // Extract session cookie
  const cookieHeader = context.request.headers.get('cookie') ?? '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
  const token = match?.[1] ?? '';

  if (!verifySessionToken(token)) {
    // Return a raw Response so the Location header is a plain relative path.
    // context.redirect() resolves relative URLs against context.request.url which
    // can drop the port when the Node adapter builds the URL from a Host header
    // that omits it (e.g. "localhost" instead of "localhost:4322").
    const nextParam =
      pathname !== '/' && !pathname.startsWith('/api/')
        ? `?next=${encodeURIComponent(pathname)}`
        : '';
    return new Response(null, {
      status: 302,
      headers: { Location: `/login${nextParam}` },
    });
  }

  // Valid session — proceed
  const response = await next();

  // Refresh cookie (sliding window) — skip if the response already sets its own cookie
  // (e.g. logout clears it, login sets a fresh one) or if it's a streaming SSE response.
  const contentType = response.headers.get('content-type') ?? '';
  const alreadySetsCookie = response.headers.has('Set-Cookie');
  if (!contentType.includes('text/event-stream') && !alreadySetsCookie) {
    const newToken = generateSessionToken();
    response.headers.set('Set-Cookie', makeSessionCookieHeader(newToken));
  }

  return response;
});
