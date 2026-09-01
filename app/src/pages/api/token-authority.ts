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
 */

import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';

const INDEXER_URL = process.env.INDEXER_URL ?? 'http://api-web-server:3000';

export const POST: APIRoute = async ({ request }) => {
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

  try {
    // Fan-out: one request per address, all in parallel
    const perAddress = await Promise.all(
      addresses.map(async (addr) => {
        const res = await fetch(
          `${INDEXER_URL}/api/v2/address/${encodeURIComponent(addr)}/token-authority?items=100`,
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
    return json({ ok: false, error: String(err) }, 502);
  }
};
