/**
 * Module-level toast store - shared across all React islands on the page.
 * Uses useSyncExternalStore-compatible subscribe/getSnapshot pattern.
 */

export type ToastStatus = 'pending' | 'confirmed' | 'failed';

export interface TxToast {
  id: string;       // same as txId
  txId: string;
  explorerUrl: string;
  status: ToastStatus;
  blockHeight?: number;
  errorMessage?: string;
  /** When the toast entered 'pending' — drives the "still pending" escalation. */
  pendingSince?: number;
  /** True once a pending toast has been waiting for >3 min — UI should say
   *  "still pending — check the explorer" instead of the plain spinner copy. */
  stale?: boolean;
}

let toasts: TxToast[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export const toastStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getSnapshot(): TxToast[] {
    return toasts;
  },
  add(toast: TxToast) {
    toasts = [toast, ...toasts];
    notify();
  },
  update(txId: string, patch: Partial<TxToast>) {
    toasts = toasts.map(t => t.id === txId ? { ...t, ...patch } : t);
    notify();
  },
  dismiss(txId: string) {
    toasts = toasts.filter(t => t.id !== txId);
    notify();
  },
};

function explorerBase(): string {
  const network = typeof document !== 'undefined'
    ? (document.body.dataset['network'] ?? 'mainnet')
    : 'mainnet';
  return network === 'testnet'
    ? 'https://lovelace.explorer.mintlayer.org'
    : 'https://explorer.mintlayer.org';
}

export function explorerTxUrl(txId: string): string {
  return `${explorerBase()}/tx/${txId}`;
}

export function explorerPoolUrl(poolId: string): string {
  return `${explorerBase()}/pool/${poolId}`;
}

export function explorerDelegationUrl(delegationId: string): string {
  return `${explorerBase()}/delegation/${delegationId}`;
}

/**
 * Ask the server for a transaction's real state (indexer-backed). The
 * /api/tx-status endpoint reports "pending" for mempool transactions on a
 * 1.4.1 indexer; "unknown" means the indexer cannot see the tx at all
 * (offline, pre-1.4.1, or dropped/evicted) and the wallet-side watcher
 * remains the authority.
 */
async function checkTxStatus(
  txId: string,
): Promise<{ status: 'pending' | 'confirmed' | 'unknown'; confirmations?: number | null }> {
  try {
    const res = await fetch(`/api/tx-status?id=${encodeURIComponent(txId)}`);
    if (!res.ok) return { status: 'unknown' };
    return (await res.json()) as { status: 'pending' | 'confirmed' | 'unknown' };
  } catch {
    return { status: 'unknown' };
  }
}

function markConfirmed(txId: string) {
  toastStore.update(txId, { status: 'confirmed', stale: false });
  // Auto-dismiss after 8 s
  setTimeout(() => toastStore.dismiss(txId), 8_000);
}

/**
 * Submit a transaction, show a toast, watch for confirmation.
 * Returns the tx_id on broadcast; resolves the confirmation in the background.
 */
export async function submitWithToast(
  txPromise: () => Promise<string>,            // must return tx_id
  watchFn: (txId: string) => Promise<unknown>, // watchTx from txWatcher
): Promise<string> {
  const txId = await txPromise();
  const url  = explorerTxUrl(txId);

  toastStore.add({ id: txId, txId, explorerUrl: url, status: 'pending', pendingSince: Date.now() });

  // A pending toast must never spin forever without a reality check: if the
  // watcher hasn't resolved after 3 minutes, ask the indexer whether the tx
  // is actually still pending (1.4.1 mempool visibility) instead of guessing.
  let statusChecks = 0;
  let escalate: ReturnType<typeof setTimeout> | undefined;
  const runStatusCheck = () => {
    statusChecks++;
    void checkTxStatus(txId).then((st) => {
      const t = toastStore.getSnapshot().find((x) => x.id === txId);
      if (!t || t.status !== 'pending') return;
      if (st.status === 'confirmed') {
        // The wallet event was missed but the chain state is final.
        markConfirmed(txId);
        return;
      }
      // Still in the mempool (or the indexer cannot see it) - surface the
      // honest "still pending" copy and keep waiting on the wallet watcher.
      toastStore.update(txId, { stale: true });
      if (st.status === 'pending' && statusChecks < 3) {
        escalate = setTimeout(runStatusCheck, 120_000);
      }
    });
  };
  escalate = setTimeout(runStatusCheck, 180_000);

  watchFn(txId)
    .then((res) => {
      if (escalate) clearTimeout(escalate);
      const bh = (res as { block_height?: number }).block_height;
      toastStore.update(txId, { status: 'confirmed', blockHeight: bh, stale: false });
      // Auto-dismiss after 8 s
      setTimeout(() => toastStore.dismiss(txId), 8_000);
    })
    .catch(async (err: Error) => {
      if (escalate) clearTimeout(escalate);
      if (err.message !== 'Transaction confirmation timed out') {
        toastStore.update(txId, { status: 'failed', errorMessage: err.message });
        return;
      }
      // The wallet-side watcher gave up - check ground truth before declaring
      // failure. A tx still sitting in the mempool is pending, not failed.
      const st = await checkTxStatus(txId);
      const t = toastStore.getSnapshot().find((x) => x.id === txId);
      if (!t || t.status !== 'pending') return; // already resolved or dismissed
      if (st.status === 'confirmed') {
        markConfirmed(txId);
      } else if (st.status === 'pending') {
        toastStore.update(txId, { stale: true });
      } else {
        toastStore.update(txId, {
          status: 'failed',
          errorMessage: 'Transaction confirmation timed out',
        });
      }
    });

  return txId;
}
