/**
 * txWatcher - client-side singleton that shares the /api/block-stream
 * EventSource and exposes watchTx(txId) to await on-chain confirmation.
 */

type TxState =
  | { type: 'Confirmed'; content: { block_height: number } }
  | { type: 'InMempool' }
  | { type: 'Conflicted'; content: { with_block: string } }
  | { type: 'Inactive' }
  | { type: 'Abandoned' };

type Callback = (state: TxState) => void;

const watchers = new Map<string, Callback>();
let es: EventSource | null = null;

function ensureStream() {
  if (es && es.readyState !== EventSource.CLOSED) return;

  es = new EventSource('/api/block-stream');

  es.onmessage = (e: MessageEvent) => {
    try {
      const msg = JSON.parse(e.data as string) as
        | { type: 'TxUpdated'; tx_id: string; state: TxState }
        | { type: 'TxDropped'; tx_id: string }
        | { type: 'NewBlock' }
        | { type: 'error' };

      if (msg.type === 'TxUpdated') {
        watchers.get(msg.tx_id)?.(msg.state);
      } else if (msg.type === 'TxDropped') {
        watchers.get(msg.tx_id)?.({ type: 'Inactive' });
      }
    } catch { /* ignore malformed */ }
  };

  const source = es;
  source.onerror = () => {
    // Close the errored EventSource before dropping the reference - without
    // this a second watchTx could open a duplicate stream (Minor hardening).
    source.close();
    es = null;
  };
}

/**
 * Resolves when `txId` is confirmed on-chain.
 * Rejects if the tx is conflicted, abandoned, or times out (5 min).
 */
export function watchTx(txId: string): Promise<{ block_height: number }> {
  ensureStream();

  return new Promise((resolve, reject) => {
    const TIMEOUT = 5 * 60 * 1000;

    const timer = setTimeout(() => {
      watchers.delete(txId);
      reject(new Error('Transaction confirmation timed out'));
    }, TIMEOUT);

    watchers.set(txId, (state) => {
      if (state.type === 'Confirmed') {
        clearTimeout(timer);
        watchers.delete(txId);
        resolve({ block_height: state.content.block_height });
      } else if (state.type === 'Conflicted' || state.type === 'Abandoned') {
        clearTimeout(timer);
        watchers.delete(txId);
        reject(new Error(`Transaction ${state.type.toLowerCase()}`));
      }
      // InMempool / Inactive - keep waiting
    });
  });
}
