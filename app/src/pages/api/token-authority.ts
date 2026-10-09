/**
 * /api/token-authority  (POST)
 *
 * Body: { addresses: string[] }
 *
 * Queries the indexer for all tokens where any of the given addresses is the
 * authority. Used by IssuedTokensPanel to discover tokens issued from other
 * browsers / devices / CLI.
 *
 * Returns { ok: true, result: string[] } - deduplicated token IDs.
 *
 * Session-authenticated so this endpoint is not an open indexer proxy: the
 * GUI binds all interfaces and this route fans out one upstream request per
 * address, which would otherwise let anyone multiply requests against the
 * indexer without limit.
 */

import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';
import { getPref } from '@/lib/prefs-db';

const INDEXER_URL = process.env.INDEXER_URL ?? 'http://api-web-server:3000';

// One upstream indexer request per address — cap the fan-out like
// address-tokens.ts so a runaway tab can't hammer the indexer.
const MAX_ADDRESSES = 200;

export const POST: APIRoute = async ({ request }) => {
  // Same session check as /api/tx-status: verify against the CURRENT session
  // version so revoked tokens stay revoked.
  const cookieHeader = request.headers.get('cookie') ?? '';
  const sessionToken =
    cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`))?.[1] ?? '';
  const sessionVersion = getPref<number>('auth.session_version') ?? 0;
  if (!verifySessionToken(sessionToken, sessionVersion)) {
    return new Response('Unauthorized', { status: 401 });
  }

  let addresses: string[] = [];
  try {
    const body = await request.json() as { addresses?: unknown };
    if (Array.isArray(body.addresses)) {
      addresses = (body.addresses as unknown[])
        .filter((a): a is string => typeof a === 'string')
        .map(a => a.trim())
        .filter(Boolean);
    }
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (addresses.length === 0) {
    return json({ ok: false, error: 'Missing addresses' }, 400);
  }
  if (addresses.length > MAX_ADDRESSES) {
    return json({ ok: false, error: `Too many addresses (max ${MAX_ADDRESSES})` }, 400);
  }

  try {
    // Fan-out: one request per address, all in parallel
    const perAddress = await Promise.all(
      addresses.map(async (addr) => {
        // The endpoint takes no query params (verified in api-server v2.rs):
        // it always returns the full authority list for the address.
        const res = await fetch(
          `${INDEXER_URL}/api/v2/address/${encodeURIComponent(addr)}/token-authority`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) return [] as string[];
        const data = await res.json() as string[];
        return Array.isArray(data) ? data : [];
      }),
    );

    // Deduplicate across all addresses
    const tokenIds = [...new Set(perAddress.flat())];
    return json({ ok: true, result: tokenIds }, 200);
  } catch (err) {
    return json({ ok: false, error: 'Indexer request failed' }, 502);
  }
};
