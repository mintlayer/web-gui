/**
 * GET /api/tx-status?id=<txid>
 *
 * Real pending/confirmed state for a transaction, straight from the indexer.
 * On 1.4.1 the indexer's /transaction/{id} falls back to the node mempool, so
 * a still-unconfirmed transaction reports status "pending" instead of 404.
 * Older indexers can only see confirmed transactions: a miss there reports
 * "unknown" (the wallet-side watcher remains the authority for those).
 *
 * Session-authenticated so this endpoint is not an open indexer proxy.
 */

import type { APIRoute } from 'astro';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';
import { getPref } from '@/lib/prefs-db';
import { getTransactionInfo, isPendingIndexerTransaction } from '@/lib/indexer';
import { getIndexerCapabilities } from '@/lib/indexer-capabilities';

export const GET: APIRoute = async ({ request, url }) => {
  // Same session check as /api/block-stream: verify against the CURRENT
  // session version so revoked tokens stay revoked.
  const cookieHeader = request.headers.get('cookie') ?? '';
  const sessionToken =
    cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`))?.[1] ?? '';
  const sessionVersion = getPref<number>('auth.session_version') ?? 0;
  if (!verifySessionToken(sessionToken, sessionVersion)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const txId = (url.searchParams.get('id') ?? '').trim();
  // Transaction ids are hex-encoded hashes (32 bytes, plus an optional
  // 1-byte tag prefix) - accept only that shape before forwarding anywhere.
  if (!/^[0-9a-fA-F]{64,66}$/.test(txId)) {
    return new Response(JSON.stringify({ error: 'invalid transaction id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const caps = await getIndexerCapabilities().catch(() => null);
  if (!caps) return json({ status: 'unknown', reason: 'indexer-unavailable' });

  let info;
  try {
    info = await getTransactionInfo(txId);
  } catch (err) {
    // 404 (or any transport failure) - the indexer cannot see the tx. On a
    // 1.4.1 indexer a broadcast-but-unconfirmed tx WOULD be visible, so a
    // miss here means dropped/evicted/unknown; let the client's wallet-side
    // watcher own the final verdict.
    return json({
      status: 'unknown',
      reason: caps.mempoolApi ? 'not-in-mempool-or-chain' : 'legacy-indexer-pending-unknown',
    });
  }

  if (isPendingIndexerTransaction(info)) {
    return json({ status: 'pending', confirmations: null });
  }
  return json({
    status: 'confirmed',
    confirmations: info.confirmations,
    block_id: info.block_id,
    timestamp: info.timestamp,
  });
};
