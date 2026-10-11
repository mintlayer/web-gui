import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { isBitcoinEnabled, getBitcoinFeeEstimate } from '@/lib/bitcoin-wallet';

/** GET /api/bitcoin/fee-estimate - smart fee estimates (sat/vB) by target. */
export const GET: APIRoute = async () => {
  if (!isBitcoinEnabled()) {
    return json({ ok: false, error: 'Bitcoin support is not enabled' }, 404);
  }
  try {
    return json(await getBitcoinFeeEstimate());
  } catch {
    // Estimates are best-effort; the send form works without them.
    return json({ ok: true, satPerVb: {} });
  }
};
