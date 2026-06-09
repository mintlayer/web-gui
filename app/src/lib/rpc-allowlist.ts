export const ALLOWED_RPC_METHODS = new Set([
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
  'wallet_open',      // was: open_wallet (wrong name)
  'wallet_create',    // was: create_wallet (wrong name)
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
  'address_sweep_spendable',
]);
