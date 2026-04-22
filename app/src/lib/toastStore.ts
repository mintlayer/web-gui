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
 * Submit a transaction, show a toast, watch for confirmation.
 * Returns the tx_id on broadcast; resolves the confirmation in the background.
 */
export async function submitWithToast(
  txPromise: () => Promise<string>,            // must return tx_id
  watchFn: (txId: string) => Promise<unknown>, // watchTx from txWatcher
): Promise<string> {
  const txId = await txPromise();
  const url  = explorerTxUrl(txId);

  toastStore.add({ id: txId, txId, explorerUrl: url, status: 'pending' });

  watchFn(txId)
    .then((res) => {
      const bh = (res as { block_height?: number }).block_height;
      toastStore.update(txId, { status: 'confirmed', blockHeight: bh });
      // Auto-dismiss after 8 s
      setTimeout(() => toastStore.dismiss(txId), 8_000);
    })
    .catch((err: Error) => {
      toastStore.update(txId, { status: 'failed', errorMessage: err.message });
    });

  return txId;
}
