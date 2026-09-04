import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import {
  isBitcoinEnabled,
  getBitcoinStatus,
  currentBitcoinAddress,
  getBitcoinBalance,
  listBitcoinTransactions,
  type BitcoinStatus,
} from '@/lib/bitcoin-wallet';

/**
 * GET /api/bitcoin/overview
 * One aggregated snapshot for the Bitcoin page: node/wallet status, balance,
 * current receive address and recent transactions. Individual pieces degrade
 * independently - a partial outage never blanks the whole page.
 */
export const GET: APIRoute = async () => {
  if (!isBitcoinEnabled()) {
    return json({ ok: false, error: 'Bitcoin support is not enabled' }, 404);
  }

  let status: BitcoinStatus | null = null;
  try {
    status = await getBitcoinStatus();
  } catch {
    status = null; // sidecar unreachable - page shows offline state
  }

  const [address, balance, txs] = await Promise.all([
    currentBitcoinAddress().catch(() => null),
    getBitcoinBalance().catch(() => null),
    listBitcoinTransactions(25).catch(() => null),
  ]);

  return json({
    ok: true,
    enabled: true,
    status,
    address: address?.address ?? null,
    balance,
    transactions: txs?.transactions ?? null,
  });
};
