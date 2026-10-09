import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';

/**
 * POST /api/bridge/ml-intent-tx
 *
 * Creates the signed-but-unbroadcast Mintlayer transaction + signed intent
 * needed for an M2E bridge request (Mintlayer -> Ethereum). Runs server-side
 * so wallet-rpc credentials never reach the browser.
 *
 * Security posture: the token_id and destination are NOT taken from the
 * request — they are resolved server-side from the bridge agents-config, so
 * a caller can only mint bridge deposits for supported tokens into the
 * bridge's own deposit address. The intent (EVM receiver) is user choice.
 *
 * Body: { token_id, amount, intent }
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
  const key = Object.keys(flavors).find((k) => flavors[k]?.m2e != null) ?? '';
  return { flavor: key, cfg: flavors[key] };
}

async function fetchJson<T>(url: string, timeoutMs = 15000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`bridge API returned ${res.status}`);
  return res.json() as Promise<T>;
}

export const POST: APIRoute = async ({ request }) => {
  let body: { token_id?: unknown; amount?: unknown; intent?: unknown };
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
  if (!/^0x[0-9a-fA-F]{40}$/.test(intent)) {
    return json({ ok: false, error: 'intent must be a 0x… Ethereum address' }, 400);
  }
  if (!/^\d+(\.\d+)?$/.test(amount) || parseFloat(amount) <= 0) {
    return json({ ok: false, error: 'amount must be a positive decimal string' }, 400);
  }

  // Resolve bridged-token + deposit destination from the live agents config
  // (never trust client-supplied destinations).
  let destination: string;
  try {
    const config = await fetchJson<AgentsConfig>(
      `${process.env.BRIDGE_API_URL ?? 'https://api.bridge.mintlayer.org/api/v1/'}agents-config`,
    );
    if (!config.ml_tokens?.[tokenId]) {
      return json({ ok: false, error: `token ${tokenId} is not bridged` }, 400);
    }
    const { cfg } = pickFlavorConfig(config);
    destination = cfg?.m2e?.deposit_tx_destination ?? '';
    if (!destination) {
      return json({ ok: false, error: 'bridge M2E deposits are not configured' }, 503);
    }
  } catch (err) {
    return json(
      { ok: false, error: `bridge config unavailable: ${(err as Error).message}` },
      503,
    );
  }

  // Create the signed, unbroadcast intent transaction via wallet-rpc-daemon.
  try {
    const auth = Buffer.from(
      `${process.env.WALLET_RPC_USERNAME}:${process.env.WALLET_RPC_PASSWORD}`,
    ).toString('base64');
    const res = await fetch(
      process.env.WALLET_RPC_URL ?? 'http://wallet-rpc-daemon:3034',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'token_make_tx_to_send_with_intent',
          params: {
            account: 0,
            token_id: tokenId,
            address: destination,
            amount,
            intent,
            options: {},
          },
        }),
        signal: AbortSignal.timeout(120_000),
      },
    );
    const data = (await res.json()) as {
      result?: { transaction?: string; signed_intent?: string };
      error?: { message?: string };
    };
    if (data.error) {
      return json({ ok: false, error: data.error.message ?? 'wallet RPC error' }, 400);
    }
    const rawTx = data.result?.transaction;
    const signedIntent = data.result?.signed_intent;
    if (!rawTx || !signedIntent) {
      return json({ ok: false, error: 'wallet returned an incomplete transaction' }, 500);
    }
    return json({ ok: true, raw_transaction: rawTx, intent: signedIntent });
  } catch (err) {
    return json(
      { ok: false, error: `wallet RPC failed: ${(err as Error).message}` },
      503,
    );
  }
};
