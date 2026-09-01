import { useState, useEffect } from 'react';
import { hexToText } from '@/lib/token-utils';
import { CopyButton } from '@/components/CopyButton';
import TokenManagePanel from '@/components/TokenManagePanel';
import { TokenIdTooltip } from '@/components/TokenIdTooltip';
import { rpc } from '@/lib/client-rpc';

// ── Types ──────────────────────────────────────────────────────────────────────

interface StoredToken {
  tokenId: string;
  ticker: string;
  decimals: number;
  issuedAt: number;
  txId?: string;
}

type FungibleContent = {
  token_id: string;
  token_ticker: { text: string | null; hex: string };
  number_of_decimals: number;
  circulating_supply: { atoms: string };
  total_supply:
    | { type: 'Fixed'; content: { atoms: string } }
    | { type: 'Lockable' }
    | { type: 'Unlimited' };
  is_locked: boolean;
  frozen: { type: 'NotFrozen' } | { type: 'Frozen'; content: { is_unfreezable: boolean } };
};

type TokenLiveInfo = { type: 'FungibleToken'; content: FungibleContent } | null;

interface Props {
  network: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TEN_MINUTES = 10 * 60 * 1000;

// ── Helpers ────────────────────────────────────────────────────────────────────

const LS_KEY = 'ml_issued_tokens';

function loadStored(): StoredToken[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as StoredToken[];
  } catch {
    return [];
  }
}

function saveStored(list: StoredToken[]) {
  // Deduplicate by tokenId before persisting
  const seen = new Set<string>();
  const deduped = list.filter(t => !seen.has(t.tokenId) && seen.add(t.tokenId));
  localStorage.setItem(LS_KEY, JSON.stringify(deduped));
}

function atomsToDecimal(atoms: string, decimals: number): string {
  if (decimals === 0) return atoms;
  const n = BigInt(atoms);
  const factor = 10n ** BigInt(decimals);
  const whole = n / factor;
  const frac = n % factor;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

function supplyBadge(info: FungibleContent) {
  const labels: string[] = [];
  if (info.is_locked) labels.push('locked');
  if (info.frozen.type === 'Frozen') labels.push('frozen');
  if (info.total_supply.type === 'Fixed' && info.circulating_supply.atoms === '0') labels.push('not minted');
  return labels;
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function IssuedTokensPanel({ network }: Props) {
  const [stored, setStored] = useState<StoredToken[]>([]);
  const [liveInfos, setLiveInfos] = useState<Map<string, TokenLiveInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [manageTokenId, setManageTokenId] = useState<string | null>(null);
  const [failedTokenIds, setFailedTokenIds] = useState<Set<string>>(new Set());

  const explorerBase = network === 'testnet'
    ? 'https://lovelace.explorer.mintlayer.org'
    : 'https://explorer.mintlayer.org';

  async function fetchLiveInfos(ids: string[]): Promise<Map<string, TokenLiveInfo>> {
    if (ids.length === 0) return new Map();
    const results = await rpc<TokenLiveInfo[]>('node_get_tokens_info', { token_ids: ids });
    const map = new Map<string, TokenLiveInfo>();
    ids.forEach((id, i) => map.set(id, results[i] ?? null));
    return map;
  }

  async function checkFailedTxs(tokens: StoredToken[], map: Map<string, TokenLiveInfo>) {
    const pendingWithTx = tokens.filter(t => map.get(t.tokenId) === null && t.txId);
    if (pendingWithTx.length === 0) return;
    try {
      const pendingTxIds = await rpc<string[]>('transaction_list_pending', { account: 0 });
      const pendingSet = new Set(pendingTxIds);
      const failed = pendingWithTx.filter(t => !pendingSet.has(t.txId!));
      if (failed.length > 0) {
        setFailedTokenIds(prev => {
          const next = new Set(prev);
          failed.forEach(t => next.add(t.tokenId));
          return next;
        });
      }
    } catch { /* ignore - best effort */ }
  }

  async function loadLiveInfos(tokens: StoredToken[]) {
    if (tokens.length === 0) { setLoading(false); return; }
    try {
      const map = await fetchLiveInfos(tokens.map(t => t.tokenId));
      setLiveInfos(map);
      sweepStaleTokens(tokens, map);
      await checkFailedTxs(tokens, map);
    } catch {
      // silently fail - we still show stored data
    } finally {
      setLoading(false);
    }
  }

  function sweepStaleTokens(tokens: StoredToken[], map: Map<string, TokenLiveInfo>) {
    const now = Date.now();
    const staleIds = new Set(
      tokens
        .filter(t => map.get(t.tokenId) === null && t.issuedAt > 0 && now - t.issuedAt > TEN_MINUTES)
        .map(t => t.tokenId)
    );
    if (staleIds.size === 0) return;
    setStored(prev => {
      const updated = prev.filter(t => !staleIds.has(t.tokenId));
      saveStored(updated);
      return updated;
    });
    setLiveInfos(prev => { const next = new Map(prev); staleIds.forEach(id => next.delete(id)); return next; });
    setFailedTokenIds(prev => { const next = new Set(prev); staleIds.forEach(id => next.delete(id)); return next; });
  }

  function removeToken(tokenId: string) {
    const updated = stored.filter(t => t.tokenId !== tokenId);
    saveStored(updated);
    setStored(updated);
    setLiveInfos(prev => { const next = new Map(prev); next.delete(tokenId); return next; });
    setFailedTokenIds(prev => { const next = new Set(prev); next.delete(tokenId); return next; });
  }

  /** Scan the indexer for tokens where any of our wallet addresses is authority. */
  async function augmentFromIndexer(current: StoredToken[]) {
    try {
      // Check indexer is up first
      const statusRes = await fetch('/api/indexer-status');
      const status = await statusRes.json() as { up: boolean };
      if (!status.up) return;

      // Get all wallet addresses (receive + change - authority could be either)
      const addresses = await rpc<{ address: string }[]>(
        'address_show', { account: 0, include_change_addresses: true }
      );
      if (addresses.length === 0) return;

      const res = await fetch('/api/token-authority', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: addresses.map(a => a.address) }),
      });
      const data = await res.json() as { ok: boolean; result?: string[]; error?: string };
      if (!data.ok || !data.result) return;

      const knownIds = new Set(current.map(t => t.tokenId));
      const newIds = data.result.filter(id => !knownIds.has(id));
      if (newIds.length === 0) return;

      // Fetch info for newly discovered tokens so we can persist ticker/decimals
      const infoMap = await fetchLiveInfos(newIds);
      const newEntries: StoredToken[] = newIds.map(id => {
        const info = infoMap.get(id);
        const ticker = info?.type === 'FungibleToken' ? (hexToText(info.content.token_ticker) ?? '???') : '???';
        const decimals = info?.type === 'FungibleToken' ? info.content.number_of_decimals : 0;
        return { tokenId: id, ticker, decimals, issuedAt: Date.now() };
      });

      const merged = [...current, ...newEntries];
      saveStored(merged);
      setStored(merged);
      setLiveInfos(prev => {
        const next = new Map(prev);
        infoMap.forEach((v, k) => next.set(k, v));
        return next;
      });
    } catch {
      // Indexer augmentation is best-effort - don't surface errors
    }
  }

  /**
   * Scan the wallet's UTXO set for IssueFungibleToken outputs.
   * Works without the indexer — falls back to this when the indexer is not running.
   */
  async function augmentFromWallet(current: StoredToken[]) {
    try {
      const res = await fetch('/api/scan-issued-tokens');
      const data = await res.json() as {
        ok: boolean;
        fungible?: Array<{ tokenId: string; ticker: string; decimals: number }>;
      };
      if (!data.ok || !data.fungible || data.fungible.length === 0) return;

      // Use current to filter what's already known at call time
      const knownIds = new Set(current.map(t => t.tokenId));
      const newEntries: StoredToken[] = data.fungible
        .filter(t => !knownIds.has(t.tokenId))
        .map(t => ({ tokenId: t.tokenId, ticker: t.ticker, decimals: t.decimals, issuedAt: Date.now() }));

      if (newEntries.length === 0) return;

      const infoMap = await fetchLiveInfos(newEntries.map(t => t.tokenId));

      // Use functional updater to merge with whatever state is current (avoids races with augmentFromIndexer)
      setStored(prev => {
        const existingIds = new Set(prev.map(t => t.tokenId));
        const addable = newEntries.filter(t => !existingIds.has(t.tokenId));
        if (addable.length === 0) return prev;
        const merged = [...prev, ...addable];
        saveStored(merged);
        return merged;
      });
      setLiveInfos(prev => {
        const next = new Map(prev);
        infoMap.forEach((v, k) => next.set(k, v));
        return next;
      });
    } catch {
      // UTXO augmentation is best-effort - don't surface errors
    }
  }

  useEffect(() => {
    const list = loadStored();
    setStored(list);
    loadLiveInfos(list);
    augmentFromIndexer(list);
    augmentFromWallet(list);

    const es = new EventSource('/api/block-stream');
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as { type: string };
        if (msg.type === 'NewBlock') {
          setLiveInfos(current => {
            const hasPending = [...current.values()].some(v => v === null);
            if (hasPending) loadLiveInfos(loadStored());
            return current;
          });
        }
      } catch { /* ignore */ }
    };

    const resyncInterval = setInterval(() => {
      const list = loadStored();
      loadLiveInfos(list);
      augmentFromWallet(list);
    }, 2 * 60 * 1000);

    return () => { es.close(); clearInterval(resyncInterval); };
  }, []);

  function refresh() {
    loadLiveInfos(stored);
  }

  if (loading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }

  if (stored.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        No authoritable tokens found. Use <strong className="text-gray-400">Mint Token</strong> above to create one.
      </p>
    );
  }

  return (
    <>
      <div className="rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-900/60 text-left text-xs text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3">Token</th>
              <th className="px-4 py-3">Token ID</th>
              <th className="px-4 py-3 text-right">Circulating</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/60">
            {stored.map(token => {
              const live = liveInfos.get(token.tokenId);
              const content = live?.type === 'FungibleToken' ? live.content : null;
              const ticker = content?.token_ticker.text ?? token.ticker;
              const decimals = content?.number_of_decimals ?? token.decimals;
              const circulating = content ? atomsToDecimal(content.circulating_supply.atoms, decimals) : '-';
              const badges = content ? supplyBadge(content) : [];
              const supplyType = content?.total_supply.type ?? '-';
              const isPending = live === null;
              const isFailed = failedTokenIds.has(token.tokenId);

              return (
                <tr key={token.tokenId} className="bg-gray-900 hover:bg-gray-800/60 transition-colors">
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-200">{ticker}</span>
                      <TokenIdTooltip tokenId={token.tokenId} />
                      <span className="text-xs text-gray-600">{supplyType}</span>
                      {badges.map(b => (
                        <span key={b} className={`text-xs rounded px-1.5 py-0.5 border ${
                          b === 'frozen'     ? 'bg-blue-900/40 text-blue-300 border-blue-800' :
                          b === 'locked'     ? 'bg-amber-900/40 text-amber-300 border-amber-800' :
                          'bg-gray-800 text-gray-400 border-gray-700'
                        }`}>
                          {b}
                        </span>
                      ))}
                      {isPending && !isFailed && (
                        <span className="text-xs rounded px-1.5 py-0.5 border bg-yellow-900/40 text-yellow-300 border-yellow-800">
                          pending
                        </span>
                      )}
                      {isFailed && (
                        <span className="text-xs rounded px-1.5 py-0.5 border bg-red-900/40 text-red-300 border-red-800">
                          tx failed
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1">
                      <a href={`${explorerBase}/token/${token.tokenId}`} target="_blank" rel="noopener"
                         className="font-mono text-xs text-mint-400 hover:text-mint-300 transition-colors">
                        {token.tokenId.slice(0, 16)}…
                      </a>
                      <CopyButton value={token.tokenId} title="Copy token ID" />
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-200 text-xs">
                    {circulating}
                    {circulating !== '-' && (
                      <span className="inline-flex items-center gap-1 ml-1">
                        <span className="text-gray-500">{ticker}</span>
                        <TokenIdTooltip tokenId={token.tokenId} align="right" />
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isPending ? (
                      <button
                        onClick={() => removeToken(token.tokenId)}
                        className={`rounded-lg border px-3 py-1 text-xs font-semibold transition-colors ${
                          isFailed
                            ? 'border-red-800 text-red-400 hover:bg-red-900/30'
                            : 'border-gray-700 text-gray-400 hover:bg-gray-800/50'
                        }`}
                      >
                        Remove
                      </button>
                    ) : (
                      <button
                        onClick={() => setManageTokenId(token.tokenId)}
                        className="rounded-lg border bg-mint-700/30 hover:bg-mint-700/60 border-mint-800 text-mint-300 px-3 py-1 text-xs font-semibold transition-colors"
                      >
                        Manage
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>


      {manageTokenId && (
        <TokenManagePanel
          tokenId={manageTokenId}
          onClose={() => setManageTokenId(null)}
          onRefresh={refresh}
        />
      )}
    </>
  );
}
