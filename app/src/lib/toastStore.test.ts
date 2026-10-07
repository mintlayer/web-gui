/**
 * Tests for toastStore.ts - the useSyncExternalStore-compatible toast state.
 *
 * The store is a module-level singleton. Each describe block resets module state
 * via vi.resetModules() + dynamic import so toasts[] and listeners start fresh.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── toastStore ────────────────────────────────────────────────────────────────

describe('toastStore', () => {
  let toastStore: typeof import('@/lib/toastStore').toastStore;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/toastStore');
    toastStore = mod.toastStore;
  });

  const makeToast = (id: string) => ({
    id,
    txId: id,
    explorerUrl: `https://explorer.mintlayer.org/tx/${id}`,
    status: 'pending' as const,
  });

  it('getSnapshot returns [] initially', () => {
    expect(toastStore.getSnapshot()).toEqual([]);
  });

  it('add() prepends a toast', () => {
    toastStore.add(makeToast('tx1'));
    toastStore.add(makeToast('tx2'));
    const toasts = toastStore.getSnapshot();
    expect(toasts[0].id).toBe('tx2'); // most recent first
    expect(toasts[1].id).toBe('tx1');
  });

  it('add() notifies subscribers', () => {
    const listener = vi.fn();
    toastStore.subscribe(listener);
    toastStore.add(makeToast('tx1'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('update() patches a toast by id', () => {
    toastStore.add(makeToast('tx1'));
    toastStore.update('tx1', { status: 'confirmed', blockHeight: 42 });
    const [toast] = toastStore.getSnapshot();
    expect(toast.status).toBe('confirmed');
    expect(toast.blockHeight).toBe(42);
  });

  it('update() does not affect other toasts', () => {
    toastStore.add(makeToast('tx1'));
    toastStore.add(makeToast('tx2'));
    toastStore.update('tx1', { status: 'confirmed' });
    const tx2 = toastStore.getSnapshot().find(t => t.id === 'tx2');
    expect(tx2?.status).toBe('pending');
  });

  it('update() notifies subscribers', () => {
    const listener = vi.fn();
    toastStore.add(makeToast('tx1'));
    toastStore.subscribe(listener);
    listener.mockClear();
    toastStore.update('tx1', { status: 'confirmed' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dismiss() removes a toast by id', () => {
    toastStore.add(makeToast('tx1'));
    toastStore.add(makeToast('tx2'));
    toastStore.dismiss('tx1');
    const ids = toastStore.getSnapshot().map(t => t.id);
    expect(ids).not.toContain('tx1');
    expect(ids).toContain('tx2');
  });

  it('dismiss() notifies subscribers', () => {
    const listener = vi.fn();
    toastStore.add(makeToast('tx1'));
    toastStore.subscribe(listener);
    listener.mockClear();
    toastStore.dismiss('tx1');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('subscribe() returns an unsubscribe function', () => {
    const listener = vi.fn();
    const unsubscribe = toastStore.subscribe(listener);
    unsubscribe();
    toastStore.add(makeToast('tx1'));
    expect(listener).not.toHaveBeenCalled();
  });
});

// ── explorerTxUrl / explorerPoolUrl / explorerDelegationUrl ───────────────────

describe('explorer URL helpers', () => {
  let explorerTxUrl: (txId: string) => string;
  let explorerPoolUrl: (poolId: string) => string;
  let explorerDelegationUrl: (delegationId: string) => string;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/toastStore');
    explorerTxUrl = mod.explorerTxUrl;
    explorerPoolUrl = mod.explorerPoolUrl;
    explorerDelegationUrl = mod.explorerDelegationUrl;
  });

  it('explorerTxUrl returns mainnet URL by default', () => {
    const url = explorerTxUrl('abc123');
    expect(url).toBe('https://explorer.mintlayer.org/tx/abc123');
  });

  it('explorerPoolUrl returns mainnet pool URL', () => {
    const url = explorerPoolUrl('pool1');
    expect(url).toBe('https://explorer.mintlayer.org/pool/pool1');
  });

  it('explorerDelegationUrl returns mainnet delegation URL', () => {
    const url = explorerDelegationUrl('del1');
    expect(url).toBe('https://explorer.mintlayer.org/delegation/del1');
  });
});

// ── submitWithToast ───────────────────────────────────────────────────────────

describe('submitWithToast', () => {
  let submitWithToast: typeof import('@/lib/toastStore').submitWithToast;
  let toastStore: typeof import('@/lib/toastStore').toastStore;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/toastStore');
    submitWithToast = mod.submitWithToast;
    toastStore = mod.toastStore;
  });

  // Flush the microtask queue so that resolved promises' .then() callbacks run
  const flushPromises = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  it('calls txPromise and returns the txId', async () => {
    const txPromise = vi.fn().mockResolvedValue('tx123');
    const watchFn = vi.fn().mockResolvedValue({ block_height: 100 });
    const result = await submitWithToast(txPromise, watchFn);
    expect(result).toBe('tx123');
  });

  it('adds a "pending" toast immediately after broadcast', async () => {
    const txPromise = vi.fn().mockResolvedValue('tx999');
    const watchFn = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    await submitWithToast(txPromise, watchFn);
    const toasts = toastStore.getSnapshot();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ txId: 'tx999', status: 'pending' });
  });

  it('updates toast to "confirmed" when watchFn resolves', async () => {
    const txPromise = vi.fn().mockResolvedValue('txConfirm');
    const watchFn = vi.fn().mockResolvedValue({ block_height: 42 });
    await submitWithToast(txPromise, watchFn);
    await flushPromises();
    const toast = toastStore.getSnapshot().find(t => t.id === 'txConfirm');
    expect(toast?.status).toBe('confirmed');
    expect(toast?.blockHeight).toBe(42);
  });

  it('updates toast to "failed" when watchFn rejects', async () => {
    const txPromise = vi.fn().mockResolvedValue('txFail');
    const watchFn = vi.fn().mockRejectedValue(new Error('abandoned'));
    await submitWithToast(txPromise, watchFn);
    await flushPromises();
    const toast = toastStore.getSnapshot().find(t => t.id === 'txFail');
    expect(toast?.status).toBe('failed');
    expect(toast?.errorMessage).toBe('abandoned');
  });

  it('auto-dismisses confirmed toast after 8 seconds', async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const freshMod = await import('@/lib/toastStore');
      const txPromise = vi.fn().mockResolvedValue('txAutoDismiss');
      // Use a watchFn that resolves synchronously after we advance time
      let resolveWatch!: (v: unknown) => void;
      const watchFn = vi.fn().mockReturnValue(new Promise(r => { resolveWatch = r; }));
      await freshMod.submitWithToast(txPromise, watchFn);

      // Toast is pending
      expect(freshMod.toastStore.getSnapshot().find(t => t.id === 'txAutoDismiss')).toBeDefined();

      // Resolve the watchFn - the .then() schedules a setTimeout(8s)
      resolveWatch({ block_height: 1 });
      // Flush the microtask queue so the .then() body runs and sets up setTimeout
      await Promise.resolve();
      await Promise.resolve();

      // Toast is now confirmed, 8s timer is scheduled but not fired yet
      expect(freshMod.toastStore.getSnapshot().find(t => t.id === 'txAutoDismiss')?.status).toBe('confirmed');

      // Advance past the 8-second auto-dismiss
      vi.advanceTimersByTime(8_001);
      expect(freshMod.toastStore.getSnapshot().find(t => t.id === 'txAutoDismiss')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── submitWithToast + /api/tx-status reality checks ───────────────────────────

describe('submitWithToast indexer-backed status checks', () => {
  let submitWithToast: typeof import('@/lib/toastStore').submitWithToast;
  let toastStore: typeof import('@/lib/toastStore').toastStore;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/toastStore');
    submitWithToast = mod.submitWithToast;
    toastStore = mod.toastStore;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const txStatusResponse = (body: object) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

  it('escalation marks the toast stale while the tx is really pending, and re-arms', async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValue(txStatusResponse({ status: 'pending', confirmations: null }));
    const txPromise = vi.fn().mockResolvedValue('txPending');
    const watchFn = vi.fn().mockReturnValue(new Promise(() => {})); // wallet watcher never fires

    await submitWithToast(txPromise, watchFn);
    expect(toastStore.getSnapshot().find(t => t.id === 'txPending')?.stale).toBeFalsy();

    // First reality check at 3 min: tx still in the mempool -> honest copy
    await vi.advanceTimersByTimeAsync(180_001);
    expect(toastStore.getSnapshot().find(t => t.id === 'txPending')?.stale).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/tx-status?id=txPending');

    // Re-armed check at +2 min keeps polling while the mempool says pending
    await vi.advanceTimersByTimeAsync(120_001);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toastStore.getSnapshot().find(t => t.id === 'txPending')?.status).toBe('pending');
  });

  it('escalation confirms the toast when the indexer says confirmed (missed wallet event)', async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValue(txStatusResponse({ status: 'confirmed', confirmations: 1 }));
    const txPromise = vi.fn().mockResolvedValue('txMissed');
    const watchFn = vi.fn().mockReturnValue(new Promise(() => {}));

    await submitWithToast(txPromise, watchFn);
    await vi.advanceTimersByTimeAsync(180_001);

    expect(toastStore.getSnapshot().find(t => t.id === 'txMissed')?.status).toBe('confirmed');
    // No further polling once resolved
    await vi.advanceTimersByTimeAsync(120_001);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('escalation stops polling when the indexer cannot see the tx', async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValue(txStatusResponse({ status: 'unknown' }));
    const txPromise = vi.fn().mockResolvedValue('txGhost');
    const watchFn = vi.fn().mockReturnValue(new Promise(() => {}));

    await submitWithToast(txPromise, watchFn);
    await vi.advanceTimersByTimeAsync(180_001);
    expect(toastStore.getSnapshot().find(t => t.id === 'txGhost')?.stale).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toastStore.getSnapshot().find(t => t.id === 'txGhost')?.status).toBe('pending');
  });

  it('watcher timeout + indexer says pending: toast stays pending, not failed', async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValue(txStatusResponse({ status: 'pending', confirmations: null }));
    const txPromise = vi.fn().mockResolvedValue('txSlow');
    const watchFn = vi.fn().mockRejectedValue(new Error('Transaction confirmation timed out'));

    await submitWithToast(txPromise, watchFn);
    await vi.advanceTimersByTimeAsync(0);

    const toast = toastStore.getSnapshot().find(t => t.id === 'txSlow');
    expect(toast?.status).toBe('pending');
    expect(toast?.stale).toBe(true);
  });

  it('watcher timeout + indexer says confirmed: toast is confirmed', async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValue(txStatusResponse({ status: 'confirmed', confirmations: 2 }));
    const txPromise = vi.fn().mockResolvedValue('txLate');
    const watchFn = vi.fn().mockRejectedValue(new Error('Transaction confirmation timed out'));

    await submitWithToast(txPromise, watchFn);
    await vi.advanceTimersByTimeAsync(0);

    expect(toastStore.getSnapshot().find(t => t.id === 'txLate')?.status).toBe('confirmed');
  });

  it('watcher timeout + indexer cannot see the tx: failed with the timeout message', async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValue(txStatusResponse({ status: 'unknown' }));
    const txPromise = vi.fn().mockResolvedValue('txGone');
    const watchFn = vi.fn().mockRejectedValue(new Error('Transaction confirmation timed out'));

    await submitWithToast(txPromise, watchFn);
    await vi.advanceTimersByTimeAsync(0);

    const toast = toastStore.getSnapshot().find(t => t.id === 'txGone');
    expect(toast?.status).toBe('failed');
    expect(toast?.errorMessage).toBe('Transaction confirmation timed out');
  });

  it('non-timeout rejections still fail immediately without consulting the indexer', async () => {
    fetchMock.mockReturnValue(txStatusResponse({ status: 'confirmed' }));
    const txPromise = vi.fn().mockResolvedValue('txConflicted');
    const watchFn = vi.fn().mockRejectedValue(new Error('transaction conflicted'));

    await submitWithToast(txPromise, watchFn);
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    const toast = toastStore.getSnapshot().find(t => t.id === 'txConflicted');
    expect(toast?.status).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
