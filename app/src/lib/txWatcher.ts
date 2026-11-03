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

// A Set per tx id: two islands (or a retried submit) may watch the SAME tx.
// A single-callback map would let the first promise's timeout delete the
// second (live) watcher, so both callers miss the confirmation.
const watchers = new Map<string, Set<Callback>>();
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
        watchers.get(msg.tx_id)?.forEach((cb) => cb(msg.state));
      } else if (msg.type === 'TxDropped') {
        // A drop is definitive - the tx left the mempool. Map to Conflicted
        // (which watchTx rejects immediately) instead of Inactive, whose
        // keep-waiting semantics would burn the full timeout and then
        // surface a neutral 'not tracked' hint for a tx that can never
        // confirm.
        watchers.get(msg.tx_id)?.forEach((cb) => cb({ type: 'Conflicted', content: { with_block: '' } }));
      }
    } catch { /* ignore malformed */ }
  };

  const source = es;
  source.onerror = () => {
    // EventSource reconnects transient drops on its own (readyState
    // CONNECTING) - closing here would kill auto-recovery and leave every
    // in-flight watchTx to burn the full 5-minute timeout on a tx that may
    // have confirmed during the blip. Close ONLY when the browser gave up
    // (CLOSED); the next watchTx then opens a fresh stream.
    if (source.readyState === EventSource.CLOSED) {
      es = null;
    }
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

    const settle = (fail: Error | null) => {
      clearTimeout(timer);
      const set = watchers.get(txId);
      set?.delete(callback);
      // Only drop the map entry while this watcher's own callback is still
      // registered - a stale promise must never remove a NEWER watcher.
      if (set && set.size === 0) watchers.delete(txId);
      if (fail) reject(fail);
      else resolve(resolved);
    };
    const resolved = { block_height: 0 };
    const timer = setTimeout(() => settle(new Error('Transaction confirmation timed out')), TIMEOUT);

    const callback = (state: TxState) => {
      if (state.type === 'Confirmed') {
        resolved.block_height = state.content.block_height;
        settle(null);
      } else if (state.type === 'Conflicted' || state.type === 'Abandoned') {
        settle(new Error(`Transaction ${state.type.toLowerCase()}`));
      }
      // InMempool / Inactive - keep waiting
    };
    const set = watchers.get(txId) ?? new Set<Callback>();
    set.add(callback);
    watchers.set(txId, set);
  });
}
