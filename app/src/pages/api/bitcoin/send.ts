import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { isBitcoinEnabled, sendBitcoin } from '@/lib/bitcoin-wallet';
import { requireStepUp, totpFromBody } from '@/lib/step-up';
import { isValidAmount } from '@/lib/validation';

/**
 * POST /api/bitcoin/send - send BTC.
 *
 * Money-movement endpoint: requires a fresh TOTP code (step-up) on top of the
 * session cookie, is rate limited, and accepts each code at most once.
 *
 * Amount arrives as a decimal string and is re-validated here (shared
 * validator) before the sidecar performs the authoritative checks (network +
 * precision + funds). Sidecar internals are never echoed to the client —
 * only whitelisted, user-fixable error classes pass through.
 */

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!isBitcoinEnabled()) {
    return json({ ok: false, error: 'Bitcoin support is not enabled' }, 404);
  }

  let address = '';
  let amountBtc = '';
  let feeRateSatVb: number | undefined;
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
    if (typeof body.address === 'string') address = body.address.trim();
    if (typeof body.amount_btc === 'string') amountBtc = body.amount_btc.trim();
    if (typeof body.fee_rate_sat_vb === 'number') {
      // Clamp to a sane sat/vB range: a zero or negative fee would be rejected
      // downstream anyway, and an absurd fee (fat-finger or hostile body) would
      // drain the wallet into miner fees. 1..1000 sat/vB covers all regimes.
      const fee = Math.floor(body.fee_rate_sat_vb);
      if (fee >= 1 && fee <= 1000) feeRateSatVb = fee;
    }
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  if (!address) {
    return json({ ok: false, error: 'Destination address is required' }, 400);
  }
  if (!isValidAmount(amountBtc, 8)) {
    return json(
      { ok: false, error: 'Amount must be a positive number with at most 8 decimals' },
      400,
    );
  }

  const stepUp = requireStepUp(totpFromBody(body), request, clientAddress as string | undefined);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  try {
    const result = await sendBitcoin({ address, amountBtc, feeRateSatVb });
    return json(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    console.error('[bitcoin/send]', err);
    // The sidecar returns sanitized messages; network-level failures get a
    // generic one so raw fetch internals never reach the client.
    const message =
      status === 503
        ? 'Bitcoin wallet service unavailable'
        : status === 504
          ? 'The send timed out — the transaction may or may not have been broadcast. Check History before sending again to avoid paying twice.'
          : ((err as Error).message || 'Bitcoin send failed');
    return json(
      { ok: false, error: message },
      status === 503 ? 503 : status === 504 ? 504 : status === 409 ? 409 : 400,
    );
  }
};
