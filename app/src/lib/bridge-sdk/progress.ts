/**
 * Bridge progress tracking: persistence for the in-flight bridge, the
 * derived progress model, and the /subscribe WebSocket URL.
 *
 * The backend republishes Postgres NOTIFY events (request status
 * changes, deposit/withdrawal confirmations) over GET /subscribe as a
 * WebSocket, with GET /bridge-request/:uuid as the authoritative
 * polling fallback. Progress is derived from the request object's
 * actual status enum; unknown statuses count as "in progress".
 */

import type { BridgeRequestDetail } from './types';

export type { BridgeRequestDetail };
import { getBridgeApiUrl } from './config';

export const IN_FLIGHT_KEY = 'bridge_in_flight';
export const IN_FLIGHT_EVENT = 'bridge-in-flight-changed';
/** EVM-side deposits are processed after this many confirmations. */
export const DEPOSIT_CONFIRMATIONS = 12;
export const PROGRESS_POLL_MS = 10_000;

export interface InFlightBridge {
  uuid: string;
  /** On-chain deposit transaction hash (Etherscan-linkable). */
  txHash: string;
  /**
   * Mintlayer-side deposit tx id, backfilled from polling. ML→ETH
   * deposits have no hash at submit time (the Mojito wallet broadcasts
   * the deposit) — the id only becomes visible once the API echoes it.
   */
  depositTxHash?: string;
  asset: string;
  amount: string;
  receiver: string;
  destinationChain: 'ML' | 'ETH';
  startedAt: string;
  /** Highest progress step already surfaced to the user. */
  lastStep: number;
}

export const saveInFlight = (record: InFlightBridge): void => {
  try {
    localStorage.setItem(IN_FLIGHT_KEY, JSON.stringify(record));
  } catch {
    /* storage unavailable — the card just won't survive a refresh */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(IN_FLIGHT_EVENT));
  }
};

/** Terminal records stop being restored after this grace period. */
const TERMINAL_RETENTION_MS = 48 * 60 * 60 * 1000;

export const loadInFlight = (): InFlightBridge | null => {
  try {
    const raw = localStorage.getItem(IN_FLIGHT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as InFlightBridge;
    if (!parsed || typeof parsed.uuid !== 'string' || !parsed.uuid) {
      return null;
    }
    // localStorage is user-writable: a type-confused field must fail
    // closed here rather than crash a renderer downstream (CHAINS
    // lookup, toLocaleLowerCase, React object children).
    if (
      (parsed.destinationChain !== 'ML' && parsed.destinationChain !== 'ETH') ||
      typeof parsed.asset !== 'string' ||
      typeof parsed.amount !== 'string' ||
      typeof parsed.receiver !== 'string' ||
      typeof parsed.txHash !== 'string' ||
      (parsed.depositTxHash !== undefined &&
        typeof parsed.depositTxHash !== 'string')
    ) {
      return null;
    }
    // A tampered/legacy record without a usable lastStep would swallow
    // every future transition — normalize it.
    const lastStep = Number.isFinite(parsed.lastStep)
      ? (parsed.lastStep as number)
      : 0;
    const record: InFlightBridge = { ...parsed, lastStep };
    // Terminal records are retained only for a grace period (all fields
    // are public chain data, but no reason to keep them forever).
    if (
      record.lastStep >= 5 &&
      Date.now() - new Date(record.startedAt).getTime() > TERMINAL_RETENTION_MS
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
};

export const clearInFlight = (): void => {
  try {
    localStorage.removeItem(IN_FLIGHT_KEY);
  } catch {
    /* unavailable */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(IN_FLIGHT_EVENT));
  }
};

/** GET /api/v1/subscribe as a WebSocket URL (http→ws upgrade). */
export const getSubscribeUrl = (bridgeApiUrl?: string): string =>
  (bridgeApiUrl ?? getBridgeApiUrl()).replace(/^http/, 'ws') + 'subscribe';

export type BridgeProgressKind =
  | 'in-progress'
  | 'completed'
  | 'manual'
  | 'failed';

export interface BridgeProgress {
  /** 1–2 registration/broadcast, 3 deposit confirmed, 4 bridging, 5 terminal. */
  step: number;
  kind: BridgeProgressKind;
  depositConfirmed: boolean;
  /** First on-chain deposit tx hash seen on the request (source chain). */
  depositTxHash: string | null;
  /**
   * Payout (withdrawal-leg) transaction hash: Mintlayer-side when the
   * destination is ML, Ethereum-side when the destination is ETH.
   */
  mlTxHash: string | null;
  rawStatus: string;
}

const MANUAL_STATUSES = new Set([
  'manual',
  'needs_manual_handling',
  'needsmanualhandling',
]);

// Mintlayer transaction ids are 64 hex chars (optionally 0x-prefixed).
// The hash is linkified into the explorer URL, so only well-formed ids
// pass — a hostile API response must not be able to inject an arbitrary
// path into the explorer link.
const ML_TX_HASH_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;

const isHashLike = (value: unknown): value is string =>
  typeof value === 'string' && ML_TX_HASH_RE.test(value);

/** 64 hex chars, optionally 0x-prefixed — either chain's tx id shape. */
export const isTxHashLike = isHashLike;

/** EVM transaction hashes: strictly 0x + 64 hex chars. */
export const isEthTxHash = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);

const getDeposits = (
  request: BridgeRequestDetail,
): Array<Record<string, unknown>> =>
  Array.isArray(request.deposit_transactions)
    ? (request.deposit_transactions as Array<Record<string, unknown>>)
    : [];

/** First well-formed deposit tx hash on the request, if any. Each
 *  candidate key is validated independently — a malformed primary key
 *  must not shadow a valid fallback in the same entry. */
const firstDepositHash = (request: BridgeRequestDetail): string | null => {
  for (const deposit of getDeposits(request)) {
    for (const key of ['transaction_hash', 'tx_id', 'hash']) {
      const value = deposit?.[key];
      if (isHashLike(value)) return value;
    }
  }
  return null;
};

const findHash = (
  record: Record<string, unknown>,
  keys: string[],
): string | null => {
  for (const key of keys) {
    if (isHashLike(record[key])) return record[key];
  }
  const nested = record.withdrawal_transaction;
  if (nested && typeof nested === 'object') {
    const hash = (nested as Record<string, unknown>).hash;
    if (isHashLike(hash)) return hash;
  }
  return null;
};

const depositConfirmed = (request: BridgeRequestDetail): boolean =>
  getDeposits(request).some((deposit) => {
    const status = String(deposit?.status ?? '').toLowerCase();
    const confirmations = Number(deposit?.confirmations ?? NaN);
    return (
      ['confirmed', 'mined', 'finalized'].includes(status) ||
      (Number.isFinite(confirmations) && confirmations >= DEPOSIT_CONFIRMATIONS)
    );
  });

/**
 * Maps a bridge request onto the user-facing progress steps. Unknown
 * statuses count as "in progress" — never as errors.
 */
export const deriveProgress = (
  request: BridgeRequestDetail,
): BridgeProgress => {
  const raw = request as unknown as Record<string, unknown>;
  const rawStatus = String(raw.status ?? '').toLowerCase();
  const confirmed = depositConfirmed(request);
  const mlTxHash = findHash(raw, [
    'withdrawal_transaction_hash',
    'ml_transaction_hash',
    'mint_transaction_hash',
    'withdrawal_tx_hash',
  ]);

  const kind: BridgeProgressKind =
    rawStatus === 'completed'
      ? 'completed'
      : rawStatus === 'failed'
        ? 'failed'
        : MANUAL_STATUSES.has(rawStatus)
          ? 'manual'
          : 'in-progress';

  let step: number;
  if (kind !== 'in-progress') {
    step = 5;
  } else if (rawStatus === 'processed_by_master') {
    // The master agent only picks requests whose deposit it has seen.
    step = 4;
  } else {
    step = confirmed ? 3 : 2;
  }

  return {
    step,
    kind,
    depositConfirmed: confirmed || step >= 4,
    depositTxHash: firstDepositHash(request),
    mlTxHash,
    rawStatus,
  };
};
