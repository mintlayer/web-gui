export const ALLOWED_RPC_METHODS = new Set([
  // Node info
  'node_best_block_height',
  'node_chainstate_info',
  // Account
  'account_balance',
  // Addresses
  'address_new',
  'address_show',
  // NOTE: address_send and token_send are intentionally absent — sends are
  // money movement and require TOTP step-up via POST /api/send. They must not
  // be callable through the browser proxy or the plugin context.
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
  // delegation_withdraw / staking_sweep_delegation KEPT for now (risk accepted):
  // DelegationPanel.tsx withdraw flow calls them through this proxy, so removing
  // them breaks a shipped feature. They DO move coins to a client-chosen
  // destination — a stolen session cookie can drain delegated funds without the
  // TOTP step-up. Migrate to a dedicated requireStepUp endpoint, then remove.
  'delegation_withdraw',
  'staking_sweep_delegation',
  // Wallet — open/create are handled server-side only (setup.astro, wallet.astro)
  // and must not be callable through the browser proxy or plugin context.
  'wallet_info',
  'wallet_best_block',
  // Tokens
  'node_get_tokens_info',
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
  // Wallet settings — non-sensitive only
  // NOTE: wallet_show_seed_phrase and wallet_unlock_private_keys are intentionally
  // absent — they are handled server-side in management/wallet.astro directly.
  'wallet_lock_private_keys',
  'wallet_set_lookahead_size',
  // Transactions
  'transaction_list_by_address',
  'transaction_list_pending',
  'transaction_abandon',
  // UTXOs
  'account_utxos',
  // address_sweep_spendable removed: with `all: true` (or empty from_addresses)
  // it moves every spendable UTXO to a client-chosen destination in one call —
  // a full wallet drain reachable with a bare session cookie, which defeats
  // the address_send/token_send removal. If the UI ever needs sweep, expose it
  // through a dedicated step-up-protected endpoint (requireStepUp) that fixes
  // the account server-side.
]);
