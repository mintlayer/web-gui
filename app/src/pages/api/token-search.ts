/**
 * /api/token-search?ticker=... - Proxy to the indexer's ticker search.
 * Returns a JSON array of token IDs matching the ticker substring.
 */

import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';

const INDEXER_URL = process.env.INDEXER_URL ?? 'http://api-web-server:3000';

export const GET: APIRoute = async ({ url }) => {
  const ticker = url.searchParams.get('ticker') ?? '';
  if (!ticker) {
    return json({ ok: false, error: 'Missing ticker param' }, 400);
  }

  try {
    const res = await fetch(
      `${INDEXER_URL}/api/v2/token/ticker/${encodeURIComponent(ticker)}?items=20`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) {
      return json({ ok: false, error: `Indexer error ${res.status}` }, 502);
    }
    const tokenIds = await res.json();
    return json({ ok: true, result: tokenIds }, 200);
  } catch (err) {
    return json({ ok: false, error: String(err) }, 502);
  }
};
