import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { rpcCall, WalletRpcError } from '@/lib/wallet-rpc';
import { requireStepUp, totpFromBody } from '@/lib/step-up';
import { getServerBridgeApiUrl } from '@/lib/bridge-sdk/config';
import { apiRequest } from '@/lib/bridge-sdk/http';
import { isPositiveDecimal, isEvmAddress } from '@/lib/validation';
import { validateEvmAddress } from '@/lib/bridge-sdk/addresses';

/**
 * POST /api/bridge/ml-intent-tx
 *
 * Creates the signed-but-unbroadcast Mintlayer transaction + signed intent
 * needed for an M2E bridge request (Mintlayer -> Ethereum). Runs server-side
 * so wallet-rpc credentials never reach the browser.
 *
 * Security posture:
 *  - Money-movement endpoint: requires a fresh, single-use TOTP code
 *    (step-up) on top of the session cookie, plus per-IP rate limiting.
 *  - The token_id and destination are NOT taken from the request - they are
 *    resolved server-side from the bridge agents-config, so a caller can only
 *    mint bridge deposits for supported tokens into the bridge's own deposit
 *    address. The intent (EVM receiver) is user choice.
 *  - Wallet/bridge internals are never echoed to the client; only
 *    whitelisted, user-fixable error classes pass through.
 *
 * Body: { token_id, amount, intent, totp_code }
 *  - token_id: Mintlayer token id (must be a bridged ML token)
 *  - amount:   decimal amount string (token units)
 *  - intent:   destination Ethereum address (0x…)
 * Returns: { ok, raw_transaction, intent } on success.
 */

interface AgentsConfig {
  network_type: string;
  ml_tokens: Record<string, string>;
  eth_flavor_specific_config: Record<
    string,
    {
      m2e: { deposit_tx_destination: string } | null;
    }
  >;
}

function pickFlavorConfig(config: AgentsConfig) {
  const flavors = config.eth_flavor_specific_config ?? {};
  // Flavor keys are network-specific ('' = mainnet, 'sepolia' = testnet) and
  // their order is not - pick the one matching the configured network first.
  const preferred = config.network_type === 'mainnet' ? '' : 'sepolia';
  const key =
    flavors[preferred]?.m2e != null
      ? preferred
      : (Object.keys(flavors).find((k) => flavors[k]?.m2e != null) ?? '');
  return { flavor: key, cfg: flavors[key] };
}

/**
 * Whitelist wallet-rpc failures into safe, user-fixable messages.
 * Transport failures (code -32000/-32001) and daemon HTTP >=500 are service
 * outages, not user mistakes - they must return 503 so the UI doesn't tell
 * the user to fix something they cannot. Daemon JSON-RPC rejections keep the
 * whitelist below; anything unrecognized stays generic (never echo daemon
 * internals such as URLs to the client).
 */
function safeWalletError(err: unknown): { message: string; status: number } {
  if (err instanceof WalletRpcError) {
    if (err.code === -32000 || err.code === -32001 || err.code >= 500) {
      console.error('[bridge/ml-intent-tx] wallet RPC transport failure:', err);
      return { message: 'Wallet service unavailable', status: 503 };
    }
    const msg = err.message.toLowerCase();
    if (msg.includes('insufficient')) return { message: 'Insufficient funds for this transfer', status: 400 };
    if (msg.includes('not open') || msg.includes('wallet not')) return { message: 'Wallet is not open - open it from the dashboard first', status: 409 };
    if (msg.includes('balance')) return { message: 'Insufficient balance for this transfer', status: 400 };
    return { message: 'Wallet rejected the bridge transaction', status: 400 };
  }
  console.error('[bridge/ml-intent-tx] wallet RPC failure:', err);
  return { message: 'Wallet service unavailable', status: 503 };
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  const tokenId = typeof body.token_id === 'string' ? body.token_id.trim() : '';
  const amount = typeof body.amount === 'string' ? body.amount.trim() : '';
  const intent = typeof body.intent === 'string' ? body.intent.trim() : '';

  if (!tokenId || !amount || !intent) {
    return json({ ok: false, error: 'token_id, amount and intent are required' }, 400);
  }
  if (!isEvmAddress(intent) || !validateEvmAddress(intent).valid) {
    // Regex alone accepts any 40-hex string; the EIP-55 checksum (or a fully
    // single-case address) is what catches a mistyped receiver before funds
    // are irreversibly bridged.
    return json({ ok: false, error: 'intent must be a valid Ethereum address' }, 400);
  }
  if (!isPositiveDecimal(amount)) {
    return json({ ok: false, error: 'amount must be a positive decimal string' }, 400);
  }

  // Resolve bridged-token + deposit destination from the live agents config
  // BEFORE the step-up gate (never trust client-supplied destinations). Every
  // failure below this point would otherwise burn the user's authenticator
  // code for an error knowable without the wallet.
  let destination: string;
  try {
    const config = await apiRequest<AgentsConfig>(
      `${getServerBridgeApiUrl().replace(/\/+$/, '')}/agents-config`,
    );
    if (typeof config.ml_tokens?.[tokenId] !== 'string') {
      // Not `!config.ml_tokens?.[tokenId]` - truthiness would pass inherited
      // Object properties (constructor/toString/__proto__) and burn a code
      // for a request the wallet would reject anyway.
      return json({ ok: false, error: `token ${tokenId} is not bridged` }, 400);
    }
    const { cfg } = pickFlavorConfig(config);
    destination = cfg?.m2e?.deposit_tx_destination ?? '';
    if (!destination) {
      return json({ ok: false, error: 'bridge M2E deposits are not configured' }, 503);
    }
  } catch (err) {
    console.error('[bridge/ml-intent-tx] agents-config unavailable:', err);
    return json({ ok: false, error: 'bridge config unavailable' }, 503);
  }

  // Step-up LAST before the RPC call: validates + burns the TOTP code. From
  // here on every failure has already consumed the code, so responses carry
  // code_consumed:true (the UI tells the user to enter a fresh code).
  const stepUp = requireStepUp(totpFromBody(body), request, clientAddress as string | undefined);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  // Create the signed, unbroadcast intent transaction via wallet-rpc-daemon
  // (shared rpcCall: auth, URL, timeout, JSON/error handling in one place).
  try {
    const result = await rpcCall<{ transaction?: string; signed_intent?: string }>(
      'token_make_tx_to_send_with_intent',
      {
        account: 0,
        token_id: tokenId,
        address: destination,
        amount,
        intent,
        options: {},
      },
      { timeoutMs: 120_000 },
    );
    const rawTx = result?.transaction;
    const signedIntent = result?.signed_intent;
    if (!rawTx || !signedIntent) {
      return json({ ok: false, error: 'wallet returned an incomplete transaction', code_consumed: true }, 500);
    }
    return json({ ok: true, raw_transaction: rawTx, intent: signedIntent });
  } catch (err) {
    const { message, status } = safeWalletError(err);
    // The TOTP code was verified + burned before the RPC call; tell the UI so
    // it can ask for a fresh code instead of silently failing a retry.
    return json({ ok: false, error: message, code_consumed: true }, status);
  }
};
