/**
 * /api/address-tokens?addresses=addr1,addr2,...
 *
 * Returns token holdings per address by querying the indexer for address balances,
 * then resolving ticker and NFT flag via the indexer's /token/{id} and /nft/{id} endpoints.
 *
 * Response: { ok: true, result: { [address]: TokenHolding[] } }
 */

import type { APIRoute } from 'astro';

const INDEXER_URL = process.env.INDEXER_URL ?? 'http://api-web-server:3000';

interface IndexerAddressBalance {
  tokens: Array<{ token_id: string; amount: { atoms: string; decimal: string } }>;
}

interface IndexerToken {
  token_ticker?: { string: string | null };
}

interface IndexerNft {
  metadata?: { ticker?: { string: string | null }; name?: { string: string | null } };
}

interface TokenHolding {
  token_id: string;
  amount: { atoms: string; decimal: string };
  ticker: string;
  isNFT: boolean;
}

export const GET: APIRoute = async ({ url }) => {
  const raw = url.searchParams.get('addresses') ?? '';
  const addresses = raw.split(',').map(a => a.trim()).filter(Boolean);

  if (addresses.length === 0) {
    return json({ ok: false, error: 'Missing addresses param' }, 400);
  }

  try {
    // Fan-out to indexer - one request per address, all in parallel
    const perAddress = await Promise.all(
      addresses.map(async (addr) => {
        const res = await fetch(
          `${INDEXER_URL}/api/v2/address/${encodeURIComponent(addr)}`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) return { addr, tokens: [] as IndexerAddressBalance['tokens'] };
        const data = await res.json() as IndexerAddressBalance;
        return { addr, tokens: Array.isArray(data.tokens) ? data.tokens : [] };
      }),
    );

    // Collect all unique token IDs across all addresses
    const allTokenIds = [...new Set(perAddress.flatMap(p => p.tokens.map(t => t.token_id)))];

    // Enrich with ticker + NFT flag directly from the indexer's /token/{id} and /nft/{id} endpoints
    const tickerMap = new Map<string, { ticker: string; isNFT: boolean }>();
    await Promise.all(
      allTokenIds.map(async (id) => {
        // Try fungible token first
        const tokenRes = await fetch(
          `${INDEXER_URL}/api/v2/token/${encodeURIComponent(id)}`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (tokenRes.ok) {
          const data = await tokenRes.json() as IndexerToken;
          const ticker = data.token_ticker?.string ?? id.slice(0, 8);
          tickerMap.set(id, { ticker, isNFT: false });
          return;
        }
        // Fall back to NFT endpoint
        const nftRes = await fetch(
          `${INDEXER_URL}/api/v2/nft/${encodeURIComponent(id)}`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (nftRes.ok) {
          const data = await nftRes.json() as IndexerNft;
          const ticker = data.metadata?.ticker?.string ?? data.metadata?.name?.string ?? 'NFT';
          tickerMap.set(id, { ticker, isNFT: true });
        }
      }),
    );

    // Build result map
    const result: Record<string, TokenHolding[]> = {};
    for (const { addr, tokens } of perAddress) {
      result[addr] = tokens.map(t => ({
        token_id: t.token_id,
        amount: t.amount,
        ticker: tickerMap.get(t.token_id)?.ticker ?? '???',
        isNFT: tickerMap.get(t.token_id)?.isNFT ?? false,
      }));
    }

    return json({ ok: true, result }, 200);
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
