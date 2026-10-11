/**
 * GET /api/token-intel?token_id=<bech32 id>
 *
 * On-chain supply statistics and top holders for a token, from the
 * indexer's /statistics endpoints. Holder listings are cursor-only and
 * therefore require a 1.4.1 indexer; on older indexers the endpoint
 * answers with ok:false instead of half the data.
 *
 * Session-authenticated so this is not an open indexer proxy.
 */

import type { APIRoute } from 'astro';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';
import { getPref } from '@/lib/prefs-db';
import { getTokenStatistics, listTokenHolders } from '@/lib/indexer';
import { getIndexerCapabilities } from '@/lib/indexer-capabilities';

const HOLDER_PAGE = 10;

export const GET: APIRoute = async ({ request, url }) => {
  const cookieHeader = request.headers.get('cookie') ?? '';
  const sessionToken =
    cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`))?.[1] ?? '';
  const sessionVersion = getPref<number>('auth.session_version') ?? 0;
  if (!verifySessionToken(sessionToken, sessionVersion)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const tokenId = (url.searchParams.get('token_id') ?? '').trim();
  if (tokenId.length === 0 || tokenId.length > 100) {
    return json({ ok: false, error: 'invalid token id' }, 400);
  }

  const caps = await getIndexerCapabilities().catch(() => null);
  if (!caps) return json({ ok: false, reason: 'indexer-unavailable' });
  if (!caps.mempoolApi) return json({ ok: false, reason: 'requires-1.4.1' });

  try {
    const [statistics, holders] = await Promise.all([
      getTokenStatistics(tokenId),
      listTokenHolders(tokenId, { items: HOLDER_PAGE }),
    ]);
    return json({
      ok: true,
      statistics,
      holders: holders.items,
      moreHolders: holders.next_cursor !== null,
    });
  } catch (err) {
    // A token without any holder rows (e.g. whole supply burned) can 404 on
    // the statistics side; report it as unavailable rather than an error.
    console.error('[token-intel]', err);
    return json({ ok: false, reason: 'indexer-request-failed' });
  }
};
