/**
 * Tests for txWatcher.ts - client-side EventSource-based TX confirmation.
 * Environment: jsdom (EventSource is a browser API).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── EventSource mock ──────────────────────────────────────────────────────────

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instance: MockEventSource | null = null;

  url: string;
  readyState = MockEventSource.OPEN;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instance = this;
  }

  send(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

beforeEach(() => {
  MockEventSource.instance = null;
  vi.stubGlobal('EventSource', MockEventSource);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('watchTx', () => {
  it('creates an EventSource for /api/block-stream', async () => {
    const { watchTx } = await import('@/lib/txWatcher');
    watchTx('tx1');
    expect(MockEventSource.instance).not.toBeNull();
    expect(MockEventSource.instance!.url).toBe('/api/block-stream');
  });

  it('resolves when a Confirmed TxUpdated message arrives for the watched txId', async () => {
    const { watchTx } = await import('@/lib/txWatcher');
    const promise = watchTx('tx1');

    MockEventSource.instance!.send(JSON.stringify({
      type: 'TxUpdated',
      tx_id: 'tx1',
      state: { type: 'Confirmed', content: { block_height: 42 } },
    }));

    const result = await promise;
    expect(result.block_height).toBe(42);
  });

  it('rejects when a Conflicted TxUpdated message arrives', async () => {
    const { watchTx } = await import('@/lib/txWatcher');
    const promise = watchTx('tx1');

    MockEventSource.instance!.send(JSON.stringify({
      type: 'TxUpdated',
      tx_id: 'tx1',
      state: { type: 'Conflicted', content: { with_block: 'blk1' } },
    }));

    await expect(promise).rejects.toThrow('conflicted');
  });

  it('rejects when an Abandoned TxUpdated message arrives', async () => {
    const { watchTx } = await import('@/lib/txWatcher');
    const promise = watchTx('tx1');

    MockEventSource.instance!.send(JSON.stringify({
      type: 'TxUpdated',
      tx_id: 'tx1',
      state: { type: 'Abandoned' },
    }));

    await expect(promise).rejects.toThrow('abandoned');
  });

  it('does not resolve for a TxUpdated message with a different txId', async () => {
    const { watchTx } = await import('@/lib/txWatcher');
    let settled = false;
    const promise = watchTx('tx1');
    promise.then(() => { settled = true; }).catch(() => { settled = true; });

    MockEventSource.instance!.send(JSON.stringify({
      type: 'TxUpdated',
      tx_id: 'other-tx',
      state: { type: 'Confirmed', content: { block_height: 1 } },
    }));

    // Flush microtasks
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('treats TxDropped as Inactive (keeps waiting - does not resolve or reject)', async () => {
    const { watchTx } = await import('@/lib/txWatcher');
    let settled = false;
    const promise = watchTx('tx1');
    promise.then(() => { settled = true; }).catch(() => { settled = true; });

    MockEventSource.instance!.send(JSON.stringify({ type: 'TxDropped', tx_id: 'tx1' }));

    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('does not crash on malformed JSON in stream messages', async () => {
    const { watchTx } = await import('@/lib/txWatcher');
    watchTx('tx1');

    expect(() => {
      MockEventSource.instance!.send('not-valid-json');
    }).not.toThrow();
  });

  it('rejects after 5-minute timeout', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { watchTx } = await import('@/lib/txWatcher');
    const promise = watchTx('tx1');

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    await expect(promise).rejects.toThrow('timed out');
  });

  it('reuses the existing EventSource for a second call', async () => {
    const { watchTx } = await import('@/lib/txWatcher');
    const constructorSpy = vi.fn();
    const OriginalMock = MockEventSource;
    const TrackingMock = class extends OriginalMock {
      constructor(url: string) {
        constructorSpy(url);
        super(url);
      }
    };
    vi.stubGlobal('EventSource', TrackingMock);

    watchTx('tx1');
    watchTx('tx2');

    // Only one EventSource should have been created
    expect(constructorSpy).toHaveBeenCalledTimes(1);
  });

  it('creates a new EventSource if the previous one is CLOSED', async () => {
    const { watchTx } = await import('@/lib/txWatcher');

    watchTx('tx1');
    const first = MockEventSource.instance!;
    first.close(); // Mark as CLOSED
    // Simulate the onerror handler that clears the internal reference
    first.onerror?.();

    watchTx('tx2');

    // A new EventSource should have been created
    expect(MockEventSource.instance).not.toBe(first);
  });
});
