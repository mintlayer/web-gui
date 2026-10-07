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
  return indexerGet<IndexerPoolBlockStats>(`/pool/${encodeURIComponent(poolId)}/block-stats`);
}

// ── 1.4.1 endpoints ───────────────────────────────────────────────────────────────────
//
// Everything below requires an api-web-server built from mintlayer-core
// v1.4.1 or newer. On older indexers these endpoints return 404, so callers
// should gate them on getIndexerCapabilities() (indexer-capabilities.ts) and
// degrade to the pre-1.4.1 paths when the probe reports them absent.

/** Cursor-paginated listing envelope (items 1..=100 per page). */
export interface IndexerCursorPage<T> {
  items: T[];
  /** Opaque cursor for the next page; null when the listing is exhausted. */
  next_cursor: string | null;
  /** Order book only: the storage cap truncated the scan, so the levels are an incomplete aggregation. */
  truncated?: boolean;
}

function clampPageItems(items: number): number {
  return Math.min(Math.max(Math.trunc(items), 1), 100);
}

async function indexerGetCursorPage<T>(
  path: string,
  params: Record<string, string | number>,
): Promise<IndexerCursorPage<T>> {
  return indexerGet<IndexerCursorPage<T>>(path, params);
}

function cursorPageParams(
  opts: { cursor?: string; items?: number },
  extra: Record<string, string | number> = {},
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    ...extra,
    items: clampPageItems(opts.items ?? 50),
  };
  if (opts.cursor) params.cursor = opts.cursor;
  return params;
}

// ── Transactions: pending (mempool) visibility ────────────────────────────────

/**
 * Transaction info as returned by /transaction/{id} and the mempool listing.
 * For a pending transaction the api-server sets block_id/timestamp/
 * confirmations to null, omits the fee, and leaves the spent utxos of the
 * inputs unpopulated; once confirmed the same fields carry real values.
 */
export interface IndexerTransactionInfo {
  id: string;
  block_id: string | null;
  timestamp: number | null;
  confirmations: number | null;
  /** Omitted for pending transactions. */
  fee?: IndexerAmount;
  inputs: unknown[];
  outputs: unknown[];
}

/** A pending transaction has not been indexed into a block yet. */
export function isPendingIndexerTransaction(
  info: Pick<IndexerTransactionInfo, 'block_id' | 'confirmations'>,
): boolean {
  return info.block_id === null || info.confirmations === null;
}

/**
 * Get transaction info by id. On a 1.4.1 indexer this falls back to the
 * connected node's mempool, so pending transactions are found too (the
 * response then has null block/timestamp/confirmations and no fee). Callers
 * that care about the distinction should check isPendingIndexerTransaction().
 */
export async function getTransactionInfo(txId: string): Promise<IndexerTransactionInfo> {
  return indexerGet<IndexerTransactionInfo>(`/transaction/${encodeURIComponent(txId)}`);
}

export interface IndexerMempoolListing {
  transactions: IndexerTransactionInfo[];
  /** Which ordering the listing actually ended up in (dependency can fall back to insertion). */
  ordering: 'insertion' | 'dependency';
}

/**
 * List the connected node's pending transactions. The cost is proportional to
 * the mempool size (not the page), so this is not a polling endpoint.
 */
export async function listMempoolTransactions(
  offset = 0,
  items = 50,
  order?: 'insertion' | 'dependency',
): Promise<IndexerMempoolListing> {
  const url = new URL(`${INDEXER_URL}/api/v2/mempool/transactions`);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('items', String(clampPageItems(items)));
  if (order) url.searchParams.set('order', order);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Indexer error ${res.status}: ${await res.text()}`);
  }
  const transactions = (await res.json()) as IndexerTransactionInfo[];
  const header = res.headers.get('x-mempool-ordering');
  return { transactions, ordering: header === 'dependency' ? 'dependency' : 'insertion' };
}

// ── Order book ───────────────────────────────────────────────────────────────────────

/**
 * One aggregated price level of the order book. The price is expressed in the
 * quote currency per one base unit; price.atoms is the rational "numer/denom"
 * of the level.
 */
export interface IndexerBookLevel {
  price: IndexerAmount;
  /** Total base-currency amount available at this price level. */
  amount: IndexerAmount;
}

export type IndexerOrderBookSide = 'ask' | 'bid';

/**
 * Aggregated order book for a trading pair (pair format "ML_<token_id>" or
 * "<token_id>_<token_id>"). The ask book is ordered by ascending price, the
 * bid book by descending price. Cursors are side-specific: a cursor minted
 * for one side is rejected on the other. Check `truncated` before presenting
 * the result as the complete book - the aggregation caps how many live orders
 * are scanned.
 */
export async function getOrderBook(
  pair: string,
  side: IndexerOrderBookSide,
  opts: { cursor?: string; items?: number } = {},
): Promise<IndexerCursorPage<IndexerBookLevel>> {
  return indexerGetCursorPage<IndexerBookLevel>(
    `/order/pair/${encodeURIComponent(pair)}/book`,
    cursorPageParams(opts, { side }),
  );
}

// ── Supply statistics ───────────────────────────────────────────────────────────────

export interface IndexerSupplyStatistics {
  circulating_supply: IndexerAmount;
  preminted: IndexerAmount;
  burned: IndexerAmount;
  staked: IndexerAmount;
}

/** ML supply statistics. */
export async function getCoinStatistics(): Promise<IndexerSupplyStatistics> {
  return indexerGet<IndexerSupplyStatistics>('/statistics/coin');
}

/** Supply statistics for a token (circulating/preminted/burned/staked). */
export async function getTokenStatistics(tokenId: string): Promise<IndexerSupplyStatistics> {
  return indexerGet<IndexerSupplyStatistics>(`/statistics/token/${encodeURIComponent(tokenId)}`);
}

// ── Holders ───────────────────────────────────────────────────────────────────

/** One entry of a top-holders listing, ordered by balance (zero balances excluded). */
export interface IndexerHolder {
  address: string;
  amount: IndexerAmount;
}

/** Top ML holders (cursor-paginated). */
export async function listCoinHolders(
  opts: { cursor?: string; items?: number } = {},
): Promise<IndexerCursorPage<IndexerHolder>> {
  return indexerGetCursorPage<IndexerHolder>('/statistics/coin/holders', cursorPageParams(opts));
}

/** Top holders of a token (cursor-paginated). */
export async function listTokenHolders(
  tokenId: string,
  opts: { cursor?: string; items?: number } = {},
): Promise<IndexerCursorPage<IndexerHolder>> {
  return indexerGetCursorPage<IndexerHolder>(
    `/statistics/token/${encodeURIComponent(tokenId)}/holders`,
    cursorPageParams(opts),
  );
}

// ── Fee rate ──────────────────────────────────────────────────────────────────

/**
 * Estimated fee rate to be in the top `inTopXMb` MB of the mempool, in atoms
 * per kB (a JSON string; parse before arithmetic).
 */
export async function getFeerate(inTopXMb = 5): Promise<string> {
  return indexerGet<string>('/feerate', { in_top_x_mb: inTopXMb });
}

// ── Cursor-paginated deep walks ───────────────────────────────────────────────

/**
 * Walk pools ordered by creation height with stable keyset pagination. The
 * offset-based listIndexerPools() stays the right choice for shallow listings;
 * this variant is for deep walks where offset pagination is unstable.
 */
export async function listIndexerPoolsByHeight(
  opts: { cursor?: string; items?: number } = {},
): Promise<IndexerCursorPage<IndexerPool>> {
  return indexerGetCursorPage<IndexerPool>(
    '/pool',
    cursorPageParams(opts, { sort: 'by_height' }),
  );
}

// ── Authority discovery ───────────────────────────────────────────────────────

/**
 * Token ids whose authority (mint/freeze/manage) is held by the given address.
 */
export async function listTokenAuthorities(address: string): Promise<string[]> {
  return indexerGet<string[]>(`/address/${encodeURIComponent(address)}/token-authority`);
}
