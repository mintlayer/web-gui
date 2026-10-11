export type EthFlavorConfig = {
  token_config: {
    [token: string]: {
      address: string;
      max_amount_per_request: string;
    };
  };
  infura_rpc_url: string;
  bridge_contract_address: string;
  /** Absent (null) on mainnet. */
  e2m: {
    deposit_tx_required_confirmations: number;
    ml_token_owner_address: string;
    tx_fee_change_address: string;
    bridge_contract_deposit_log_record_topic: string;
    deposit_tx_max_blocks_to_wait: number;
    withdrawal_tx_required_confirmations: number;
    resend_withdrawal_tx_after_block_count: number;
  } | null;
  /** Absent (null) on mainnet. */
  m2e: {
    deposit_tx_required_confirmations: number;
    deposit_tx_destination: string;
    deposit_tx_max_blocks_to_wait: number;
    withdrawal_tx_required_confirmations: number;
    resend_withdrawal_tx_after_block_count: number;
    multisend_contract_address: string;
    gnosis_safe_address: string;
  } | null;
};

export interface BridgeConfig {
  network_type: string;
  ml_tokens: {
    [ticker: string]: string;
  };
  eth_flavor_specific_config: {
    /** Flavor key: '' on mainnet, 'sepolia' on testnet. */
    [flavor: string]: EthFlavorConfig;
  };
}

/** Fees for one direction, in asset units / percent as decimal strings. */
export interface DirectionalFees {
  fixed_fee: string;
  percentage_fee: string;
}

/** Per-asset fees, keyed by direction: to_ml (ETH→ML deposits), to_eth (ML→ETH payouts). */
export interface AssetFees {
  to_ml?: DirectionalFees;
  to_eth?: DirectionalFees;
  [key: string]: unknown;
}

export type FeeDirection = 'to_ml' | 'to_eth';

/** Fees route: one entry per asset. */
export type BridgeFees = Record<string, AssetFees>;

export type DepositTransaction =
  | { raw_transaction: string; intent?: string; transaction_hash?: never }
  | { raw_transaction?: never; transaction_hash: string };

export interface BridgeRequestInput {
  source_chain: string;
  destination_chain: string;
  asset: string;
  amount: string;
  receiver_address: string;
  deposit_transactions: DepositTransaction[];
}

export interface BridgeRequestResponse {
  bridge_request_uuid: string;
  deposit_transaction_uuids: string[];
}

export interface BridgeRequestDetail {
  bridge_request_uuid: string;
  source_chain: string;
  destination_chain: string;
  asset: string;
  amount: string;
  receiver_address: string;
  [key: string]: unknown;
}

export interface DepositTransactionDetail {
  deposit_transaction_uuid: string;
  [key: string]: unknown;
}

export type AddressInfo = Record<string, unknown>;
export type TokenInfo = Record<string, unknown>;

export type BridgeRequestStatus =
  | 'pending'
  | 'processed_by_master'
  | 'completed'
  | 'failed'
  | 'manual';

/** One row of the network-wide bridge-requests feed. */
export interface BridgeRequestListItem {
  bridge_request_uuid: string;
  source_chain: 'mintlayer' | 'ethereum';
  destination_chain: 'mintlayer' | 'ethereum';
  /** Asset token id (or ticker). */
  asset: string;
  /** Source-chain amount before fees. */
  amount: string;
  /** Null until the master agent computes it. */
  amount_after_fees?: string | null;
  status: BridgeRequestStatus;
  withdrawal_transaction_uuid?: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface ListBridgeRequestsParams {
  /** Max rows (default 20, max 100). */
  limit?: number;
  /** Optional status filter (comma-joined into one param). */
  status?: BridgeRequestStatus[];
  /** RFC3339 cursor for polling. */
  createdAfter?: string;
}
