/**
 * Indexer REST API client - server-side only.
 *
 * The indexer (api-web-server) is an optional Docker Compose profile.
 * Start it with: docker compose --profile indexer up -d
 *
 * Base URL is configured via INDEXER_URL env var.
 * Defaults to http://api-web-server:3000 (internal Docker network name).
 */

const INDEXER_URL =
  process.env.INDEXER_URL ?? 'http://api-web-server:3000';

export const INDEXER_START_CMD = 'docker compose --profile indexer up -d';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IndexerCurrency {
  type: 'Coin' | 'Token';
  token_id?: string; // present when type === 'Token'
}

export interface IndexerAmount {
  atoms: string;
  decimal: string;
}

export interface IndexerOrder {
  order_id: string;
  conclude_destination: string;
  give_currency: IndexerCurrency;
  initially_given: IndexerAmount;
  give_balance: IndexerAmount;
  ask_currency: IndexerCurrency;
  initially_asked: IndexerAmount;
  ask_balance: IndexerAmount;
  nonce: number | null;
}

export interface IndexerToken {
  authority: string;
  is_locked: boolean;
  circulating_supply: IndexerAmount;
  token_ticker: string | null;
  metadata_uri: string | null;
  number_of_decimals: number;
  total_supply: unknown;
  frozen: boolean;
  is_token_unfreezable: boolean | null;
  is_token_freezable: boolean | null;
  next_nonce: number | null;
}

export interface IndexerPool {
  pool_id: string;
  decommission_destination: string;
  staker_balance: IndexerAmount;
  margin_ratio_per_thousand: string;
  cost_per_block: IndexerAmount;
  vrf_public_key: string;
  delegations_balance: IndexerAmount;
}

export interface IndexerPoolBlockStats {
  block_count: number;
}

// ── Probe ─────────────────────────────────────────────────────────────────────

/**
 * Returns the indexer's current chain tip height, or null if unreachable.
 * Any successful HTTP response with a parseable block_height means the server is up.
 */
export async function getIndexerChainTip(): Promise<number | null> {
  try {
    const res = await fetch(`${INDEXER_URL}/api/v2/chain/tip`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { block_height?: number };
    return typeof data.block_height === 'number' ? data.block_height : null;
  } catch {
    return null;
  }
}

/** Returns true if the indexer REST API is reachable. */
export async function isIndexerAvailable(): Promise<boolean> {
  return (await getIndexerChainTip()) !== null;
}

// ── Internal fetch helper ─────────────────────────────────────────────────────

async function indexerGet<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const url = new URL(`${INDEXER_URL}/api/v2${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Indexer error ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// ── Token endpoints ───────────────────────────────────────────────────────────

/** List all token IDs on chain (paginated). */
export async function listTokenIds(offset = 0, items = 50): Promise<string[]> {
  return indexerGet<string[]>('/token', { offset, items });
}

/** Get full token info by ID (bech32). */
export async function getIndexerToken(tokenId: string): Promise<IndexerToken> {
  return indexerGet<IndexerToken>(`/token/${tokenId}`);
}

/** Search tokens by ticker substring. */
export async function searchTokensByTicker(ticker: string, offset = 0, items = 50): Promise<string[]> {
  return indexerGet<string[]>(`/token/ticker/${encodeURIComponent(ticker)}`, { offset, items });
}

// ── Order endpoints ───────────────────────────────────────────────────────────

/** List all orders (paginated). */
export async function listIndexerOrders(offset = 0, items = 50): Promise<IndexerOrder[]> {
  return indexerGet<IndexerOrder[]>('/order', { offset, items });
}

/** Get a single order by ID. */
export async function getIndexerOrder(orderId: string): Promise<IndexerOrder> {
  return indexerGet<IndexerOrder>(`/order/${orderId}`);
}

/**
 * List orders for a trading pair.
 * pair format: "ML_<token_id>" or "<token_id>_<token_id>"
 * Use "ML" as the coin ticker.
 */
export async function listOrdersByPair(pair: string, offset = 0, items = 50): Promise<IndexerOrder[]> {
  return indexerGet<IndexerOrder[]>(`/order/pair/${pair}`, { offset, items });
}

// ── Pool endpoints ────────────────────────────────────────────────────────────

/** List all pools. */
export async function listIndexerPools(offset = 0, items = 50): Promise<IndexerPool[]> {
  return indexerGet<IndexerPool[]>('/pool', { offset, items });
}

/** Get pool block stats (how many blocks the pool has produced). */
export async function getPoolBlockStats(poolId: string): Promise<IndexerPoolBlockStats> {
  return indexerGet<IndexerPoolBlockStats>(`/pool/${poolId}/block-stats`);
}
