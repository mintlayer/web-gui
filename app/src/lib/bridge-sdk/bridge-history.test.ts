import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  listHistory,
  appendHistory,
  updateHistoryStatus,
  clearHistory,
  HISTORY_KEY,
  HISTORY_LIMIT,
  type BridgeHistoryEntry,
} from './bridge-history';

function stubStorage(): Record<string, string> {
  const store: Record<string, string> = {};
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
  return store;
}

const entry = (overrides: Partial<BridgeHistoryEntry> = {}): BridgeHistoryEntry => ({
  uuid: 'u-1',
  direction: 'e2m',
  asset: 'usdc',
  amount: '10',
  receiver: 'tmt1qabc',
  startedAt: new Date().toISOString(),
  ...overrides,
});

describe('bridge history', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = stubStorage();
  });

  afterEach(() => {
    // @ts-expect-error test cleanup of the stubbed global
    delete globalThis.localStorage;
  });

  it('starts empty and round-trips entries', () => {
    expect(listHistory()).toEqual([]);
    appendHistory(entry());
    expect(listHistory()).toHaveLength(1);
    clearHistory();
    expect(listHistory()).toEqual([]);
  });

  it('deduplicates by uuid, newest first', () => {
    appendHistory(entry({ uuid: 'a' }));
    appendHistory(entry({ uuid: 'b' }));
    appendHistory(entry({ uuid: 'a', amount: '99' }));
    const all = listHistory();
    expect(all).toHaveLength(2);
    expect(all[0]?.uuid).toBe('a');
    expect(all[0]?.amount).toBe('99');
  });

  it('caps the list length', () => {
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      appendHistory(entry({ uuid: `u-${i}` }));
    }
    expect(listHistory()).toHaveLength(HISTORY_LIMIT);
  });

  it('drops type-confused entries instead of crashing', () => {
    store[HISTORY_KEY] = JSON.stringify([
      { uuid: 'ok', direction: 'm2e', asset: 'ml', amount: '1', receiver: '0xabc', startedAt: '2026-01-01T00:00:00Z' },
      { uuid: 42, direction: 'e2m' },
      'garbage',
      { direction: 'e2m' },
      { uuid: 'bad-dir', direction: 'sideways', asset: 'ml', amount: '1', receiver: 'x', startedAt: '2026-01-01T00:00:00Z' },
    ]);
    const all = listHistory();
    // Only the fully valid entry survives; unknown directions and junk
    // dates are rejected.
    expect(all).toHaveLength(1);
    expect(all[0]?.uuid).toBe('ok');
    store[HISTORY_KEY] = JSON.stringify([
      { uuid: 'junk-date', direction: 'e2m', asset: 'ml', amount: '1', receiver: 'x', startedAt: 'not-a-date' },
    ]);
    expect(listHistory()).toHaveLength(0);
  });

  it('survives corrupt JSON and a missing store', () => {
    store[HISTORY_KEY] = '{not json';
    expect(listHistory()).toEqual([]);
    // @ts-expect-error simulate environments without localStorage
    delete globalThis.localStorage;
    expect(listHistory()).toEqual([]);
    expect(() => appendHistory(entry())).not.toThrow();
  });

  it('updates cached status only for known uuids', () => {
    appendHistory(entry({ uuid: 'a' }));
    updateHistoryStatus('a', 'completed');
    updateHistoryStatus('missing', 'completed');
    expect(listHistory()[0]?.status).toBe('completed');
  });
});
