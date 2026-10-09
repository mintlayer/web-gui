/**
 * BTC wallet client - server-side only.
 *
 * Talks to the BDK wallet sidecar (optional Docker Compose profile "bitcoin"),
 * which holds the BTC keys and uses bitcoind for chain data + broadcast.
 *
 * Base URL is configured via BITCOIN_WALLET_URL env var
 * (default http://bdk-wallet:8080, the internal Docker network name).
 * All amounts are satoshi strings - never floats.
 */

const BITCOIN_WALLET_URL =
  process.env.BITCOIN_WALLET_URL ?? 'http://bdk-wallet:8080';

const BITCOIN_WALLET_USERNAME =
  process.env.BITCOIN_WALLET_USERNAME ?? '';

const BITCOIN_WALLET_PASSWORD =
  process.env.BITCOIN_WALLET_PASSWORD ?? '';

export const BITCOIN_START_CMD = 'docker compose --profile bitcoin up -d';

/**
 * Block explorer base URL for tx/address links.
 *
 * Resolution order:
 *  1. BITCOIN_EXPLORER_URL env override (used verbatim for all networks)
 *  2. public mempool.space for mainnet/testnet/signet
 *  3. the self-hosted btc-rpc-explorer sidecar for regtest (no public
 *     explorer exists; the compose profile publishes it on localhost:3002)
 */
export function getBitcoinExplorerUrl(): string | null {
  const override = process.env.BITCOIN_EXPLORER_URL?.trim();
  if (override) return override.replace(/\/+$/, '');
  const network = (process.env.BITCOIN_NETWORK || process.env.NETWORK || 'mainnet').toLowerCase();
  switch (network) {
    case 'testnet': return 'https://mempool.space/testnet';
    case 'signet': return 'https://mempool.space/signet';
    case 'regtest': return 'http://localhost:3002';
    case 'mainnet': return 'https://mempool.space';
    default: return null;
  }
}

/** Feature flag: the bitcoin profile was enabled at init/deploy time. */
export function isBitcoinEnabled(): boolean {
  return process.env.BITCOIN_ENABLED === 'true';
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BitcoinBalance {
  confirmed: string;
  trustedPending: string;
  untrustedPending: string;
  immature: string;
  total?: string;
}

export interface BitcoinNodeInfo {
  reachable: boolean;
  blocks: number;
  headers: number;
  synced: boolean;
  initialBlockDownload: boolean;
}

export interface BitcoinStatus {
  ok: boolean;
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet' | 'unknown';
  walletExists: boolean;
  walletLoaded: boolean;
  node: BitcoinNodeInfo;
  balance: BitcoinBalance | null;
}

export interface BitcoinTransaction {
  txid: string;
  received: string;
  sent: string;
  fee: string | null;
  confirmed: boolean;
  height: number | null;
  timestamp: number | null;
}

export interface BitcoinCreateResult {
  ok: boolean;
  created: boolean;
  network: string;
  /** Only present on creation - the sidecar never returns it again. */
  mnemonic?: string;
}

// ── Sidecar error ─────────────────────────────────────────────────────────────

export class BitcoinWalletError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'BitcoinWalletError';
    this.status = status;
  }
}

// ── Internal fetch helper ─────────────────────────────────────────────────────

async function sidecarRequest<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 10_000, ...rest } = init;
  const auth = Buffer.from(`${BITCOIN_WALLET_USERNAME}:${BITCOIN_WALLET_PASSWORD}`).toString('base64');
  let res: Response;
  try {
    res = await fetch(`${BITCOIN_WALLET_URL}${path}`, {
      ...rest,
      headers: { Authorization: `Basic ${auth}`, ...(rest.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new BitcoinWalletError(
      `BTC wallet service unreachable (is the bitcoin profile running?)`,
      503,
    );
  }
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; error?: string; [key: string]: unknown }
    | null;
  if (!res.ok || !body || body.ok === false) {
    throw new BitcoinWalletError(
      body?.error ?? `BTC wallet error ${res.status}`,
      res.status,
    );
  }
  return body as T;
}

// ── Wallet lifecycle ──────────────────────────────────────────────────────────

/** Create the BTC wallet (generated seed, or restore from the given mnemonic). */
export function createBitcoinWallet(seed?: string): Promise<BitcoinCreateResult> {
  return sidecarRequest('/wallet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seed: seed ?? null }),
  });
}

/**
 * Create the BTC wallet from a seed, retrying transient sidecar
 * unavailability. The wrapper maps fetch failures to 503; 502/504 from any
 * intermediary are equally transient. Retrying is safe even when attempt 1
 * actually succeeded server-side (lost response): the sidecar then answers
 * 409 "wallet already exists", which is deterministic and never retried.
 * 4xx errors (invalid seed, already exists) are never retried.
 */
export async function createBitcoinWalletFromSeedWithRetry(
  seed: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<BitcoinCreateResult> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const delayMs = opts.delayMs ?? 3_000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await createBitcoinWallet(seed);
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof BitcoinWalletError && [502, 503, 504].includes(err.status);
      if (!retryable || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

// ── Status / sync ─────────────────────────────────────────────────────────────

/** Node + wallet overview: reachability, sync state, balances. */
export function getBitcoinStatus(): Promise<BitcoinStatus> {
  return sidecarRequest<BitcoinStatus>('/status');
}

/** Ask the sidecar to sync the wallet against bitcoind (async on its side). */
export function triggerBitcoinSync(): Promise<{ ok: boolean; syncStarted: boolean }> {
  return sidecarRequest('/sync', { method: 'POST', timeoutMs: 30_000 });
}

// ── Balance / addresses ───────────────────────────────────────────────────────

/** Confirmed + pending balances in satoshis (strings). */
export function getBitcoinBalance(): Promise<BitcoinBalance> {
  return sidecarRequest<BitcoinBalance & { ok: boolean }>('/balance');
}

/** Derive a fresh receive address. */
export function newBitcoinAddress(): Promise<{ ok: boolean; address: string }> {
  return sidecarRequest('/address/new', { method: 'POST' });
}

/** Last unused receive address (for the Receive view). */
export function currentBitcoinAddress(): Promise<{ ok: boolean; address: string }> {
  return sidecarRequest('/address/current');
}

// ── Transactions ──────────────────────────────────────────────────────────────

/** Wallet transaction history, newest first. */
export function listBitcoinTransactions(limit = 50): Promise<{ ok: boolean; transactions: BitcoinTransaction[] }> {
  return sidecarRequest(`/txs?limit=${encodeURIComponent(limit)}`);
}

export interface BitcoinSendRequest {
  address: string;
  /** BTC amount as a decimal string (max 8 decimals). */
  amountBtc: string;
  /** Optional fee rate in sat/vB. */
  feeRateSatVb?: number;
}

/** Build, sign and broadcast a transaction; resolves with the txid. */
export function sendBitcoin(req: BitcoinSendRequest): Promise<{ ok: boolean; txid: string }> {
  return sidecarRequest('/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: req.address,
      amount_btc: req.amountBtc,
      fee_rate_sat_vb: req.feeRateSatVb,
    }),
    timeoutMs: 60_000,
  });
}

/** Fee estimates in sat/vB by confirmation target (1, 3, 6, 12, 25). */
export function getBitcoinFeeEstimate(): Promise<{ ok: boolean; satPerVb: Record<string, number> }> {
  return sidecarRequest('/fee-estimate', { timeoutMs: 30_000 });
}
