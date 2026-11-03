import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { rpcCall, WalletRpcError } from '@/lib/wallet-rpc';
import { requireStepUp, totpFromBody } from '@/lib/step-up';
import { isValidAmount } from '@/lib/validation';
import { decode as bech32Decode, hrpForNetwork } from '@/lib/bech32';

/**
 * POST /api/send - send ML coins or tokens (incl. NFTs).
 *
 * Money-movement endpoint: requires a fresh TOTP code (step-up) on top of the
 * session cookie, is rate limited (inside requireStepUp), and accepts each
 * code at most once. address_send/token_send are intentionally absent from
 * the browser/plugin RPC allowlist, so this is the only send path - a stolen
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
    // Strict enum: anything that is not exactly one of the two kinds is a 400,
    // never a silent fall-through to an ML send - what the user confirmed in
    // the dialog must be what gets sent.
    if (body.asset_type !== 'ml' && body.asset_type !== 'token') {
      return json({ ok: false, error: 'asset_type must be "ml" or "token"' }, 400);
    }
    assetType = body.asset_type as 'ml' | 'token';
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
  // Knowable failures must not consume a code: decode the pasted address
  // structurally and check its HRP against this deployment's network BEFORE
  // step-up. The daemon stays authoritative for checksum and semantic checks
  // (this only rejects strings that could never be valid here).
  try {
    const expectedHrp = hrpForNetwork('ml', (process.env.NETWORK ?? 'mainnet').toLowerCase());
    const { prefix } = bech32Decode(address, 'bech32m');
    if (expectedHrp && prefix !== expectedHrp) {
      return json(
        { ok: false, error: `Destination address looks like a "${prefix}" address - this network expects "${expectedHrp}" addresses` },
        400,
      );
    }
  } catch {
    return json({ ok: false, error: 'Destination address is not a valid Mintlayer address' }, 400);
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
    // Step-up already ran: the TOTP code is burned even though nothing was
    // broadcast. Flag it so the UI can tell the user to enter a FRESH code
    // instead of silently retrying the dead one.
    if (err instanceof WalletRpcError) {
      // Transport-class failures (-32000/-32001/5xx, and daemon HTTP status
      // codes) carry the daemon URL in their message - never forward those
      // to the browser (mirror of the rpc.ts proxy redaction). Daemon
      // user-actionable messages (insufficient funds, amount too small)
      // still pass through.
      // Positive codes are daemon HTTP statuses (401/404 on bad credentials
      // carry the daemon URL in the message) - redact them too, not just 5xx.
      const transport = err.code === -32000 || err.code === -32001 || err.code >= 400;
      if (transport) console.error('[send]', err.message);
      return json({
        ok: false,
        error: transport ? 'The wallet service is unavailable. Check that all services are running.' : err.message,
        code_consumed: true,
      }, 502);
    }
    console.error('[send]', err);
    return json({ ok: false, error: 'Send failed', code_consumed: true }, 500);
  }
};
