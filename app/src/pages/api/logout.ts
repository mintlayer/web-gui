import type { APIRoute } from 'astro';
import { clearSessionCookieHeader } from '@/lib/auth';
import { getPref, setPref } from '@/lib/prefs-db';

export const POST: APIRoute = () => {
  // Invalidate outstanding tokens, not just the cookie: a captured session
  // token would stay valid until expiry unless the session version moves.
  setPref('auth.session_version', (getPref<number>('auth.session_version') ?? 0) + 1);
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/login',
      'Set-Cookie': clearSessionCookieHeader(),
    },
  });
};
