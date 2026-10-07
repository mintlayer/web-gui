import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { rpcCall, WalletRpcError } from '@/lib/wallet-rpc';
import { requireStepUp, totpFromBody } from '@/lib/step-up';
import { isValidAmount } from '@/lib/validation';

/**
 * POST /api/send - send ML coins or tokens (incl. NFTs).
 *
 * Money-movement endpoint: requires a fresh TOTP code (step-up) on top of the
 * session cookie, is rate limited (inside requireStepUp), and accepts each
 * code at most once. address_send/token_send are intentionally absent from
 * the browser/plugin RPC allowlist, so this is the only send path — a stolen
 * session cookie alone cannot move funds.
 *
 * Amount arrives as a decimal string and is re-validated here (shared
 * validator) before the daemon performs the authoritative checks (network +
 * precision + funds). ML has 9 decimals; token precision is enforced by the
 * daemon, so the endpoint-side cap is a loose sanity bound.
 */

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let address = '';
  let amount = '';
  let assetType: 'ml' | 'token' = 'ml';
  let tokenId = '';
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
    if (typeof body.address === 'string') address = body.address.trim();
    if (typeof body.amount === 'string') amount = body.amount.trim();
    if (body.asset_type === 'token') assetType = 'token';
    if (typeof body.token_id === 'string') tokenId = body.token_id.trim();
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  if (!address) {
    return json({ ok: false, error: 'Destination address is required' }, 400);
  }
  if (!isValidAmount(amount, assetType === 'ml' ? 9 : 18)) {
    return json(
      { ok: false, error: 'Amount must be a positive number with valid precision' },
      400,
    );
  }
  if (assetType === 'token' && !tokenId) {
    return json({ ok: false, error: 'token_id is required for token sends' }, 400);
  }

  const stepUp = requireStepUp(totpFromBody(body), request, clientAddress as string | undefined);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  try {
    const result =
      assetType === 'ml'
        ? await rpcCall<{ tx_id: string }>('address_send', {
            account: 0,
            address,
            amount: { decimal: amount },
            selected_utxos: [],
            options: {},
          })
        : await rpcCall<{ tx_id: string }>('token_send', {
            account: 0,
            token_id: tokenId,
            address,
            amount: { decimal: amount },
            options: {},
          });
    return json({ ok: true, tx_id: result.tx_id });
  } catch (err) {
    if (err instanceof WalletRpcError) {
      return json({ ok: false, error: err.message }, 502);
    }
    console.error('[send]', err);
    return json({ ok: false, error: 'Send failed' }, 500);
  }
};
