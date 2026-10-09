import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { isBitcoinEnabled, sendBitcoin } from '@/lib/bitcoin-wallet';

/**
 * POST /api/bitcoin/send - send BTC.
 *
 * Amount arrives as a decimal string and is re-validated here before the
 * sidecar performs the authoritative checks (network + precision + funds).
 */
const AMOUNT_RE = /^\d{1,8}(\.\d{1,8})?$/;

export const POST: APIRoute = async ({ request }) => {
  if (!isBitcoinEnabled()) {
    return json({ ok: false, error: 'Bitcoin support is not enabled' }, 404);
  }

  let address = '';
  let amountBtc = '';
  let feeRateSatVb: number | undefined;
  try {
    const body = (await request.json()) as {
      address?: unknown;
      amount_btc?: unknown;
      fee_rate_sat_vb?: unknown;
    };
    if (typeof body.address === 'string') address = body.address.trim();
    if (typeof body.amount_btc === 'string') amountBtc = body.amount_btc.trim();
    if (typeof body.fee_rate_sat_vb === 'number' && body.fee_rate_sat_vb > 0) {
      feeRateSatVb = body.fee_rate_sat_vb;
    }
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  if (!address) {
    return json({ ok: false, error: 'Destination address is required' }, 400);
  }
  if (!AMOUNT_RE.test(amountBtc) || parseFloat(amountBtc) <= 0) {
    return json(
      { ok: false, error: 'Amount must be a positive number with at most 8 decimals' },
      400,
    );
  }

  try {
    const result = await sendBitcoin({ address, amountBtc, feeRateSatVb });
    return json(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return json({ ok: false, error: (err as Error).message }, status === 503 ? 503 : 400);
  }
};
