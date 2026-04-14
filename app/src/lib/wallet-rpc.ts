/**
 * Wallet RPC client — server-side only.
 *
 * Method names and parameter shapes are taken directly from the daemon's own
 * generated docs at wallet-rpc-daemon/docs/RPC.md.
 */

const WALLET_RPC_URL =
  process.env.WALLET_RPC_URL ?? 'http://localhost:3034';

const WALLET_RPC_USERNAME =
  process.env.WALLET_RPC_USERNAME ?? '';

const WALLET_RPC_PASSWORD =
  process.env.WALLET_RPC_PASSWORD ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WalletBalance {
  coins: { atoms: string; decimal: string };
  tokens: Record<string, { atoms: string; decimal: string }>;
}

export interface AddressEntry {
  address: string;
  index: string;
  purpose: 'Receive' | 'Change';
  used: boolean;
  coins: { atoms: string; decimal: string };
}

export interface BlockInfo {
  id: string;
  height: number;
}

export interface ChainstateInfo {
  best_block_height: number;
  best_block_id: string;
  best_block_timestamp: { timestamp: number };
  median_time: { timestamp: number };
  is_initial_block_download: boolean;
}

export interface CreateWalletResult {
  mnemonic:
    | { type: 'NewlyGenerated'; content: { mnemonic: string } }
    | { type: 'UserProvided' };
}

export interface WalletInfo {
  wallet_id: string;
  account_names: (string | null)[];
}

export type StakingStatus = 'Staking' | 'NotStaking';

// ── Core JSON-RPC call ────────────────────────────────────────────────────────

let _reqId = 0;

export async function rpcCall<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const id = ++_reqId;
  const auth = Buffer.from(`${WALLET_RPC_USERNAME}:${WALLET_RPC_PASSWORD}`).toString('base64');

  let res: Response;
  try {
    res = await fetch(WALLET_RPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
  } catch (err) {
    throw new WalletRpcError(
      `Cannot reach wallet-rpc-daemon at ${WALLET_RPC_URL}: ${(err as Error).message}`,
      -32000,
    );
  }

  if (!res.ok) {
    throw new WalletRpcError(
      `HTTP ${res.status} ${res.statusText} from wallet-rpc-daemon`,
      res.status,
    );
  }

  const body = await res.json() as { result?: T; error?: { code: number; message: string } };

  if (body.error) {
    throw new WalletRpcError(body.error.message, body.error.code);
  }

  return body.result as T;
}

export class WalletRpcError extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message);
    this.name = 'WalletRpcError';
  }
}

// ── Wallet management ─────────────────────────────────────────────────────────

export async function walletInfo(): Promise<WalletInfo> {
  return rpcCall<WalletInfo>('wallet_info', {});
}

/**
 * Open an existing wallet file.
 * `path` is the full path inside the container, e.g. /home/mintlayer/wallet
 */
export async function openWallet(path: string, password?: string) {
  return rpcCall('wallet_open', {
    path,
    password: password ?? null,
    force_migrate_wallet_type: null,
    hardware_wallet: null,
  });
}

export type WalletOpenResult =
  | { status: 'ok' }
  | { status: 'needs_password' }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

/**
 * Returns true if the error indicates no wallet is currently open.
 * Used to gate auto-open attempts so we don't loop on unrelated errors.
 */
export function isWalletNotOpenError(err: unknown): boolean {
  const msg = ((err as Error)?.message ?? '').toLowerCase();
  return (
    msg.includes('no wallet') ||
    msg.includes('wallet is not open') ||
    msg.includes('wallet not open') ||
    msg.includes('wallet not loaded')
  );
}

/**
 * Attempt to auto-open /home/mintlayer/mintlayer.wallet.
 * Only call this after confirming the error is a wallet-not-open error
 * (use isWalletNotOpenError first) — otherwise you risk redirect loops.
 * Logs all outcomes to the server console for diagnostics.
 */
export async function ensureWalletOpen(walletPath = '/home/mintlayer/mintlayer.wallet'): Promise<WalletOpenResult> {
  try {
    await openWallet(walletPath);
    console.log(`[wallet] auto-opened ${walletPath}`);
    return { status: 'ok' };
  } catch (err) {
    const msg = (err as Error).message;
    const lower = msg.toLowerCase();
    if (lower.includes('password') || lower.includes('passphrase') || lower.includes('encrypted')) {
      console.log(`[wallet] auto-open: wallet is encrypted, password required (${walletPath})`);
      return { status: 'needs_password' };
    }
    if (lower.includes('not found') || lower.includes('no such file') || lower.includes('does not exist')) {
      console.log(`[wallet] auto-open: wallet file not found at ${walletPath}`);
      return { status: 'not_found' };
    }
    console.error(`[wallet] auto-open failed for ${walletPath}: ${msg}`);
    return { status: 'error', message: msg };
  }
}

/**
 * Create a new wallet file.
 * `path` is the full path inside the container, e.g. /home/mintlayer/wallet
 */
export async function createWallet(
  path: string,
  storeSeedPhrase: boolean = true,
  mnemonic?: string,
  passphrase?: string,
): Promise<CreateWalletResult> {
  return rpcCall<CreateWalletResult>('wallet_create', {
    path,
    store_seed_phrase: storeSeedPhrase,
    mnemonic: mnemonic ?? null,
    passphrase: passphrase ?? null,
    hardware_wallet: null,
  });
}

// ── Sync / node info ──────────────────────────────────────────────────────────

/** Wallet's view of the best block (reflects wallet sync state). */
export async function walletBestBlock(): Promise<BlockInfo> {
  return rpcCall<BlockInfo>('wallet_best_block', {});
}

/** Raw node best-block height (reflects node sync state). */
export async function nodeBestBlockHeight(): Promise<number> {
  return rpcCall<number>('node_best_block_height', {});
}

/** Node chainstate info — includes is_initial_block_download for sync status. */
export async function nodeChainstateInfo(): Promise<ChainstateInfo> {
  return rpcCall<ChainstateInfo>('node_chainstate_info', {});
}

// ── Account ───────────────────────────────────────────────────────────────────

export async function getBalance(account = 0, withLocked: 'Unlocked' | 'Locked' | 'Any' = 'Unlocked'): Promise<WalletBalance> {
  return rpcCall<WalletBalance>('account_balance', {
    account,
    utxo_states: ['Confirmed'],
    with_locked: withLocked,
  });
}

// ── Addresses ─────────────────────────────────────────────────────────────────

export async function newAddress(account = 0): Promise<{ address: string; index: string }> {
  return rpcCall('address_new', { account });
}

export async function showAddresses(
  account = 0,
  includeChangeAddresses = false,
): Promise<AddressEntry[]> {
  return rpcCall<AddressEntry[]>('address_show', {
    account,
    include_change_addresses: includeChangeAddresses,
  });
}

// ── Transactions ──────────────────────────────────────────────────────────────

export async function sendToAddress(
  address: string,
  amount: string,
  account = 0,
): Promise<{ tx_id: string }> {
  return rpcCall('address_send', {
    account,
    address,
    amount: { decimal: amount },
    selected_utxos: [],
    options: {},
  });
}

// ── Staking ───────────────────────────────────────────────────────────────────

export interface PoolInfo {
  pool_id: string;
  pledge: { atoms: string; decimal: string };
  balance: { atoms: string; decimal: string };
  height: number;
  block_timestamp: { timestamp: number };
  vrf_public_key: string;
  decommission_key: string;
  staker: string;
  margin_ratio_per_thousand: string;
  cost_per_block: { atoms: string; decimal: string };
}

export interface CreatedBlock {
  id: string;
  height: number;
  pool_id: string;
}

export interface DelegationInfo {
  delegation_id: string;
  pool_id: string;
  balance: { atoms: string; decimal: string };
}

export interface TxResult {
  tx_id: string;
  broadcasted: boolean;
  fees: { coins: { atoms: string; decimal: string } };
}

export async function getStakingStatus(account = 0): Promise<StakingStatus> {
  return rpcCall<StakingStatus>('staking_status', { account });
}

export async function startStaking(account = 0): Promise<void> {
  return rpcCall('staking_start', { account });
}

export async function stopStaking(account = 0): Promise<void> {
  return rpcCall('staking_stop', { account });
}

export async function listPools(account = 0): Promise<PoolInfo[]> {
  return rpcCall<PoolInfo[]>('staking_list_pools', { account });
}

export async function listCreatedBlocks(account = 0): Promise<CreatedBlock[]> {
  return rpcCall<CreatedBlock[]>('staking_list_created_block_ids', { account });
}

export async function listDelegations(account = 0): Promise<DelegationInfo[]> {
  return rpcCall<DelegationInfo[]>('delegation_list_ids', { account });
}

// ── Tokens ────────────────────────────────────────────────────────────────────

export type TokenCurrency =
  | { type: 'Coin'; content: { amount: { atoms: string; decimal: string } } }
  | { type: 'Token'; content: { id: string; amount: { atoms: string; decimal: string } } };

export interface OrderInfo {
  order_id: string;
  initially_asked: TokenCurrency;
  initially_given: TokenCurrency;
  existing_order_data: {
    ask_balance: { atoms: string; decimal: string };
    give_balance: { atoms: string; decimal: string };
    creation_timestamp: { timestamp: number };
    is_frozen: boolean;
  } | null;
  is_marked_as_frozen_in_wallet: boolean;
  is_marked_as_concluded_in_wallet: boolean;
}

export type TokenInfo =
  | {
      type: 'FungibleToken';
      content: {
        token_id: string;
        token_ticker: { text: string | null; hex: string };
        number_of_decimals: number;
        metadata_uri: { text: string | null; hex: string };
        circulating_supply: { atoms: string };
        total_supply:
          | { type: 'Fixed'; content: { atoms: string } }
          | { type: 'Lockable' }
          | { type: 'Unlimited' };
        is_locked: boolean;
        frozen: { type: 'NotFrozen' } | { type: 'Frozen'; content: { is_unfreezable: boolean } };
        authority: string;
      };
    }
  | {
      type: 'NonFungibleToken';
      content: {
        token_id: string;
        creation_tx_id: string;
        creation_block_id: string;
        metadata: {
          creator: string | null;
          name: { text: string | null; hex: string };
          description: { text: string | null; hex: string };
          ticker: { text: string | null; hex: string };
          icon_uri: { text: string | null; hex: string } | null;
          media_uri: { text: string | null; hex: string } | null;
          media_hash: string;
        };
      };
    };

export { hexToText } from '@/lib/token-utils';

export async function getTokensInfo(tokenIds: string[]): Promise<(TokenInfo | null)[]> {
  return rpcCall<(TokenInfo | null)[]>('node_get_tokens_info', { token_ids: tokenIds });
}

export async function listOwnOrders(account = 0): Promise<OrderInfo[]> {
  return rpcCall<OrderInfo[]>('order_list_own', { account });
}

export async function listAllActiveOrders(
  account = 0,
  askCurrency: { type: 'Coin' } | { type: 'Token'; content: string } | null = null,
  giveCurrency: { type: 'Coin' } | { type: 'Token'; content: string } | null = null,
): Promise<OrderInfo[]> {
  return rpcCall<OrderInfo[]>('order_list_all_active', {
    account,
    ask_currency: askCurrency,
    give_currency: giveCurrency,
  });
}

export async function createPool(
  account: number,
  amount: string,
  costPerBlock: string,
  marginRatioPerThousand: string,
  decommissionAddress: string,
): Promise<TxResult> {
  return rpcCall<TxResult>('staking_create_pool', {
    account,
    amount: { decimal: amount },
    cost_per_block: { decimal: costPerBlock },
    margin_ratio_per_thousand: marginRatioPerThousand,
    decommission_address: decommissionAddress,
    staker_address: null,
    vrf_public_key: null,
    options: {},
  });
}

export async function decommissionPool(
  account: number,
  poolId: string,
): Promise<TxResult> {
  return rpcCall<TxResult>('staking_decommission_pool', {
    account,
    pool_id: poolId,
    output_address: null,
    options: {},
  });
}

// ── Delegations ───────────────────────────────────────────────────────────────

export interface CreateDelegationResult extends TxResult {
  delegation_id: string;
}

/** Create a new delegation to a pool. `ownerAddress` receives withdrawn funds. */
export async function createDelegation(
  account: number,
  poolId: string,
  ownerAddress: string,
): Promise<CreateDelegationResult> {
  return rpcCall<CreateDelegationResult>('delegation_create', {
    account,
    pool_id: poolId,
    address: ownerAddress,
    options: {},
  });
}

/** Stake more coins into an existing delegation. */
export async function delegationStake(
  account: number,
  delegationId: string,
  amount: string,
): Promise<TxResult> {
  return rpcCall<TxResult>('delegation_stake', {
    account,
    delegation_id: delegationId,
    amount: { decimal: amount },
    options: {},
  });
}

/** Withdraw coins from a delegation to a wallet address. */
export async function delegationWithdraw(
  account: number,
  delegationId: string,
  amount: string,
  destinationAddress: string,
): Promise<TxResult> {
  return rpcCall<TxResult>('delegation_withdraw', {
    account,
    delegation_id: delegationId,
    amount: { decimal: amount },
    address: destinationAddress,
    options: {},
  });
}

/** Sweep all coins out of a delegation to a wallet address. */
export async function sweepDelegation(
  account: number,
  delegationId: string,
  destinationAddress: string,
): Promise<TxResult> {
  return rpcCall<TxResult>('staking_sweep_delegation', {
    account,
    delegation_id: delegationId,
    destination_address: destinationAddress,
    options: {},
  });
}

// ── Wallet settings ───────────────────────────────────────────────────────────

export interface SeedPhraseResult {
  seed_phrase: string[];
  passphrase: string | null;
}

export async function walletShowSeedPhrase(): Promise<SeedPhraseResult | null> {
  return rpcCall<SeedPhraseResult | null>('wallet_show_seed_phrase', {});
}

export async function walletLockPrivateKeys(): Promise<void> {
  return rpcCall('wallet_lock_private_keys', {});
}

export async function walletUnlockPrivateKeys(password: string): Promise<void> {
  return rpcCall('wallet_unlock_private_keys', { password });
}

export async function walletSetLookaheadSize(lookaheadSize: number): Promise<void> {
  return rpcCall('wallet_set_lookahead_size', {
    lookahead_size: lookaheadSize,
    i_know_what_i_am_doing: true,
  });
}

// ── Transactions ──────────────────────────────────────────────────────────────

export interface TransactionInfo {
  id: string;
  height: number;
  timestamp: { timestamp: number };
}

export async function listTransactions(
  account = 0,
  limit = 50,
): Promise<TransactionInfo[]> {
  return rpcCall<TransactionInfo[]>('transaction_list_by_address', {
    account,
    address: null,
    limit,
  });
}

export async function listPendingTransactions(account = 0): Promise<string[]> {
  return rpcCall<string[]>('transaction_list_pending', { account });
}

/** Returns the hex-encoded signed transaction bytes for a given transaction ID. */
export async function getTransactionSignedRaw(
  txId: string,
  account = 0,
): Promise<string | null> {
  return rpcCall<string | null>('transaction_get_signed_raw', {
    account,
    transaction_id: txId,
  });
}

// ── UTXOs ─────────────────────────────────────────────────────────────────────

export type UtxoValue =
  | { type: 'Coin'; content: { amount: { atoms: string; decimal: string } } }
  | { type: 'Token'; content: { id: string; amount: { atoms: string; decimal: string } } };

export type UtxoOutput =
  | { type: 'Transfer'; content: { value: UtxoValue; destination: string } }
  | {
      type: 'LockThenTransfer';
      content: {
        value: UtxoValue;
        destination: string;
        timelock:
          | { type: 'UntilHeight'; content: number }
          | { type: 'UntilTime'; content: { timestamp: number } };
      };
    }
  | { type: string; content: unknown };

export type UtxoOutpoint =
  | { source_id: { type: 'Transaction'; content: { tx_id: string } }; index: number }
  | { source_id: { type: 'BlockReward'; content: { block_id: string } }; index: number };

export interface UtxoEntry {
  outpoint: UtxoOutpoint;
  output: UtxoOutput;
}

export async function listUtxos(account = 0): Promise<UtxoEntry[]> {
  return rpcCall<UtxoEntry[]>('account_utxos', { account });
}
