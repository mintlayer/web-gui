import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  deriveProgress,
  getSubscribeUrl,
  isEthTxHash,
  isTxHashLike,
  loadInFlight,
  saveInFlight,
  clearInFlight,
  IN_FLIGHT_KEY,
  type InFlightBridge,
} from './progress';
import type { BridgeRequestDetail } from './types';

const HASH = 'a'.repeat(64);
const ETH_HASH = '0x' + 'b'.repeat(64);

function stubStorage(initial: Record<string, string> = {}): void {
  const store: Record<string, string> = { ...initial };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
  });
}

const record = (overrides: Partial<InFlightBridge> = {}): InFlightBridge => ({
  uuid: 'u-1234',
  txHash: ETH_HASH,
  asset: 'usdc',
  amount: '10',
  receiver: 'tmt1qabc',
  destinationChain: 'ML',
  startedAt: new Date().toISOString(),
  lastStep: 1,
  ...overrides,
});

const request = (overrides: Record<string, unknown> = {}): BridgeRequestDetail =>
  ({
    bridge_request_uuid: 'u-1234',
    source_chain: 'Ethereum',
    destination_chain: 'Mintlayer',
    asset: 'usdc',
    amount: '10',
    receiver_address: 'tmt1qabc',
    ...overrides,
  }) as unknown as BridgeRequestDetail;

describe('in-flight persistence', () => {
  beforeEach(() => stubStorage());

  afterEach(() => {
    // @ts-expect-error test cleanup of the stubbed global
    delete globalThis.localStorage;
  });

  it('round-trips a record', () => {
    saveInFlight(record());
    expect(loadInFlight()?.uuid).toBe('u-1234');
    clearInFlight();
    expect(loadInFlight()).toBeNull();
  });

  it('rejects type-confused records instead of crashing', () => {
    const bad = record({ destinationChain: 'mars' as unknown as 'ML' });
    localStorage.setItem(IN_FLIGHT_KEY, JSON.stringify(bad));
    expect(loadInFlight()).toBeNull();
  });

  it('normalizes a missing lastStep to 0', () => {
    const r = record();
    delete (r as { lastStep?: number }).lastStep;
    localStorage.setItem(IN_FLIGHT_KEY, JSON.stringify(r));
    expect(loadInFlight()?.lastStep).toBe(0);
  });

  it('drops terminal records after the retention window', () => {
    const old = record({
      lastStep: 5,
      startedAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
    });
    localStorage.setItem(IN_FLIGHT_KEY, JSON.stringify(old));
    expect(loadInFlight()).toBeNull();
  });
});

describe('getSubscribeUrl', () => {
  it('upgrades the API base to a ws subscribe endpoint', () => {
    expect(getSubscribeUrl('https://api.example.com/api/v1/')).toBe(
      'wss://api.example.com/api/v1/subscribe',
    );
    expect(getSubscribeUrl('http://localhost:12345/api/v1/')).toBe(
      'ws://localhost:12345/api/v1/subscribe',
    );
  });

  it('tolerates a base without the trailing slash', () => {
    expect(getSubscribeUrl('https://api.example.com/api/v1')).toBe(
      'wss://api.example.com/api/v1/subscribe',
    );
  });
});

describe('hash validators', () => {
  it('accepts well-formed hashes only', () => {
    expect(isTxHashLike(HASH)).toBe(true);
    expect(isTxHashLike('0x' + HASH)).toBe(true);
    expect(isTxHashLike('../etc/passwd')).toBe(false);
    expect(isTxHashLike('zz'.repeat(32))).toBe(false);
    expect(isEthTxHash(ETH_HASH)).toBe(true);
    expect(isEthTxHash(HASH)).toBe(false);
  });
});

describe('deriveProgress', () => {
  it('counts a fresh pending request as step 2 in progress', () => {
    const p = deriveProgress(request({ status: 'pending' }));
    expect(p.step).toBe(2);
    expect(p.kind).toBe('in-progress');
    expect(p.depositConfirmed).toBe(false);
  });

  it('marks step 3 once the deposit has enough confirmations', () => {
    const p = deriveProgress(
      request({
        status: 'pending',
        deposit_transactions: [{ transaction_hash: ETH_HASH, confirmations: 12 }],
      }),
    );
    expect(p.step).toBe(3);
    expect(p.depositConfirmed).toBe(true);
    expect(p.depositTxHash).toBe(ETH_HASH);
  });

  it('also accepts confirmed deposit status without confirmations count', () => {
    const p = deriveProgress(
      request({
        deposit_transactions: [{ status: 'confirmed', transaction_hash: HASH }],
      }),
    );
    expect(p.step).toBe(3);
  });

  it('maps processed_by_master to step 4', () => {
    const p = deriveProgress(request({ status: 'processed_by_master' }));
    expect(p.step).toBe(4);
    expect(p.kind).toBe('in-progress');
  });

  it('maps terminal statuses to step 5 with the right kind', () => {
    expect(deriveProgress(request({ status: 'completed' })).kind).toBe('completed');
    expect(deriveProgress(request({ status: 'failed' })).kind).toBe('failed');
    expect(deriveProgress(request({ status: 'manual' })).kind).toBe('manual');
    expect(deriveProgress(request({ status: 'needs_manual_handling' })).kind).toBe('manual');
    expect(deriveProgress(request({ status: 'completed' })).step).toBe(5);
  });

  it('treats unknown statuses as in progress, never as errors', () => {
    const p = deriveProgress(request({ status: 'something_new' }));
    expect(p.kind).toBe('in-progress');
  });

  it('extracts the payout hash only when well-formed', () => {
    expect(
      deriveProgress(request({ withdrawal_transaction_hash: HASH })).mlTxHash,
    ).toBe(HASH);
    expect(
      deriveProgress(request({ withdrawal_transaction_hash: '../../etc' })).mlTxHash,
    ).toBeNull();
  });

  it('falls back to a valid deposit hash when a later entry is malformed', () => {
    const p = deriveProgress(
      request({
        deposit_transactions: [
          { transaction_hash: 'not-a-hash' },
          { transaction_hash: HASH },
        ],
      }),
    );
    expect(p.depositTxHash).toBe(HASH);
  });
});
