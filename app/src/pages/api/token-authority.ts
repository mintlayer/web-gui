/**
 * /api/token-authority?addresses=addr1,addr2,...
 *
 * Queries the indexer for all tokens where any of the given addresses is the
 * authority. Used by IssuedTokensPanel to discover tokens issued from other
 * browsers / devices / CLI.
 *
 * Returns { ok: true, result: string[] } - deduplicated token IDs.
 */

import type { APIRoute } from 'astro';

const INDEXER_URL = process.env.INDEXER_URL ?? 'http://api-web-server:3000';

export const GET: APIRoute = async ({ url }) => {
  const raw = url.searchParams.get('addresses') ?? '';
  const addresses = raw.split(',').map(a => a.trim()).filter(Boolean);

  if (addresses.length === 0) {
    return json({ ok: false, error: 'Missing addresses param' }, 400);
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

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
