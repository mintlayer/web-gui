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

const PUBLIC_PATHS = new Set([
  '/login',
  '/api/login',
  '/api/passkey/auth-options',
  '/api/passkey/auth-verify',
]);
const PUBLIC_PREFIXES = ['/_astro/', '/favicon', '/_image'];

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = new URL(context.request.url);

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
}
