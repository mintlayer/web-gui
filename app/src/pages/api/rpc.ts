/**
 * /api/rpc - Server-side proxy to the wallet-rpc-daemon.
 *
 * Accepts POST requests with { method, params } and forwards them to the
 * wallet-rpc-daemon using stored credentials. This keeps credentials
 * out of the browser entirely.
 *
 * Only methods in the ALLOWED_METHODS set can be called through this route.
 */

import type { APIRoute } from 'astro';
import { rpcCall, WalletRpcError } from '@/lib/wallet-rpc';
import { checkRpcRateLimit } from '@/lib/auth';

// ── Allowlist of RPC methods callable from the browser ────────────────────────
const ALLOWED_METHODS = new Set([
  // Node info
  'node_best_block_height',
  'node_chainstate_info',
  // Account
  'account_balance',
  // Addresses
  'address_new',
  'address_show',
  // Transactions
  'address_send',
  // Staking
  'staking_status',
  'staking_start',
  'staking_stop',
  'staking_list_pools',
  'staking_list_created_block_ids',
  'staking_decommission_pool',
  'staking_create_pool',
  'delegation_list_ids',
  'delegation_create',
  'delegation_stake',
  'delegation_withdraw',
  'staking_sweep_delegation',
  // Wallet
  'wallet_info',
  'wallet_best_block',
  'open_wallet',
  'create_wallet',
  // Tokens
  'node_get_tokens_info',
  'token_send',
  'token_issue_new',
  'token_nft_issue_new',
  'token_mint',
  'token_unmint',
  'token_lock_supply',
  'token_freeze',
  'token_unfreeze',
  'token_change_authority',
  'token_change_metadata_uri',
  // Orders / Trading
  'order_list_own',
  'order_list_all_active',
  'order_create',
  'order_fill',
  'order_conclude',
  'order_freeze',
  // Wallet settings
  'wallet_show_seed_phrase',
  'wallet_lock_private_keys',
  'wallet_unlock_private_keys',
  'wallet_set_lookahead_size',
  // Transactions
  'transaction_list_by_address',
  'transaction_list_pending',
  'transaction_abandon',
  // UTXOs
  'account_utxos',
  'address_sweep_spendable',
]);

export const POST: APIRoute = async ({ request }) => {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRpcRateLimit(ip)) {
    return jsonError('Rate limit exceeded', 429);
  }

  let body: { method?: unknown; params?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { method, params } = body;

  if (typeof method !== 'string' || !method) {
    return jsonError('"method" must be a non-empty string', 400);
  }

  if (!ALLOWED_METHODS.has(method)) {
    return jsonError(`Method "${method}" is not allowed`, 403);
  }

  const rpcParams =
    params != null && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};

  try {
    const result = await rpcCall(method, rpcParams);
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof WalletRpcError ? err.message : String(err);
    const code    = err instanceof WalletRpcError ? err.code   : -1;
    return new Response(
      JSON.stringify({ ok: false, error: { message, code } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ ok: false, error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
