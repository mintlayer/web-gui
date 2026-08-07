/**
 * MCP access tiers. Mirrors src/lib/rpc-allowlist.ts but adds risk tiers so
 * the settings panel can gate what AI clients may do:
 *   read    — available whenever MCP is enabled
 *   actions — harmless writes, gated by mcp.allow_actions
 *   spend   — moves funds, gated by mcp.allow_spend
 * Methods absent from this map (seed phrase, key unlock, wallet open/create)
 * are never callable via MCP regardless of settings.
 */
export const METHOD_TIERS = {
  // read
  node_best_block_height: 'read',
  node_chainstate_info: 'read',
  account_balance: 'read',
  address_show: 'read',
  wallet_info: 'read',
  wallet_best_block: 'read',
  staking_status: 'read',
  staking_list_pools: 'read',
  staking_list_created_block_ids: 'read',
  delegation_list_ids: 'read',
  node_get_tokens_info: 'read',
  order_list_own: 'read',
  order_list_all_active: 'read',
  transaction_list_by_address: 'read',
  transaction_list_pending: 'read',
  account_utxos: 'read',
  // actions
  address_new: 'actions',
  staking_start: 'actions',
  staking_stop: 'actions',
  transaction_abandon: 'actions',
  wallet_lock_private_keys: 'actions',
  // spend
  address_send: 'spend',
  address_sweep_spendable: 'spend',
  staking_create_pool: 'spend',
  staking_decommission_pool: 'spend',
  delegation_create: 'spend',
  delegation_stake: 'spend',
  delegation_withdraw: 'spend',
  staking_sweep_delegation: 'spend',
  token_send: 'spend',
  token_issue_new: 'spend',
  token_nft_issue_new: 'spend',
  token_mint: 'spend',
  token_unmint: 'spend',
  token_lock_supply: 'spend',
  token_freeze: 'spend',
  token_unfreeze: 'spend',
  token_change_authority: 'spend',
  token_change_metadata_uri: 'spend',
  order_create: 'spend',
  order_fill: 'spend',
  order_conclude: 'spend',
  order_freeze: 'spend',
};

/**
 * @param {string} method
 * @param {{enabled: boolean, allowActions: boolean, allowSpend: boolean}} perms
 * @returns {string | null} denial reason, or null if the call is allowed
 */
export function checkMethodAccess(method, perms) {
  if (!perms.enabled) {
    return 'MCP access is disabled. Enable it in Management → Settings → MCP Server.';
  }
  const tier = Object.hasOwn(METHOD_TIERS, method) ? METHOD_TIERS[method] : undefined;
  if (!tier) {
    return `Method "${method}" is not available via MCP.`;
  }
  if (tier === 'actions' && !perms.allowActions) {
    return 'Wallet actions are disabled for MCP clients. Enable "Allow wallet actions" in Management → Settings → MCP Server.';
  }
  if (tier === 'spend' && !perms.allowSpend) {
    return 'Fund-moving operations are disabled for MCP clients. Enable "Allow fund-moving operations" in Management → Settings → MCP Server.';
  }
  return null;
}
