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
  // staking_start / staking_stop are local wallet toggles (no transaction,
  // no fund movement) — a hijacker can only pause rewards, not steal them.
  'staking_start',
  'staking_stop',
  'staking_list_pools',
  'staking_list_created_block_ids',
  'delegation_list_ids',
  // Pool creation/decommission and delegation create/stake/withdraw all sign
  // fee-bearing transactions that move funds (pool creation ~1000 ML,
  // stake/withdraw move coins). They are only reachable through POST
  // /api/stake-trade, which requires a fresh TOTP code (step-up) like
  // /api/send. The plugin context inherits this exclusion.
  // Wallet — open/create are handled server-side only (setup.astro, wallet.astro)
  // and must not be callable through the browser proxy or plugin context.
  'wallet_info',
  'wallet_best_block',
  // Tokens
  'node_get_tokens_info',
  // Token AUTHORITY methods (issue/mint/unmint/lock/freeze/change) are
  // intentionally absent — they mutate on-chain token state, several
  // irreversibly (lock_supply, is_unfreezable freeze, change_authority), and
  // burn fees. They are only reachable through POST /api/token-manage, which
  // requires a fresh TOTP code (step-up) like /api/send. The plugin context
  // inherits this exclusion: plugins can never mint/freeze/reassign tokens.
  // Orders / Trading
  'order_list_own',
  'order_list_all_active',
  // order_create / order_fill / order_conclude sign fund-moving transactions
  // (placing an order locks coins/tokens; filling pays the ask). Only
  // reachable through POST /api/stake-trade (TOTP step-up) — shared by the
  // order book and the NFT marketplace.
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
