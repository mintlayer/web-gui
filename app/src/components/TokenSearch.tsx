import { useState, useEffect } from 'react';
import type { TokenInfo } from '@/lib/wallet-rpc';
import { hexToText } from '@/lib/token-utils';
import { safeImageUri } from '@/lib/safe-uri';
import { CopyButton } from '@/components/CopyButton';
import { TokenIdTooltip } from '@/components/TokenIdTooltip';
import { getTokensInfoByIds } from '@/lib/token-info-client';

interface SearchResult {
  tokenId: string;
  info: TokenInfo | null;
}

interface FavouriteEntry {
  tokenId: string;
  ticker: string;
}

interface ExplorerTokenRow {
  tokenId: string;
  ticker: string;
  displayName: string | null;
  categories: string[];
  circulatingSupply: string;
  decimals: number;
}

/** Hard cap mirrored by the server (server allows 1000, we stay tidy). */
const FAVOURITES_CAP = 500;

interface Props {
  network: string;
}

function looksLikeTokenId(q: string): boolean {
  return q.length > 20 && !/\s/.test(q);
}

function atomsToDecimal(atoms: string, decimals: number): string {
  if (decimals === 0) return atoms;
  const n = BigInt(atoms);
  const factor = 10n ** BigInt(decimals);
  const whole = n / factor;
  const frac = n % factor;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

function getSupplyType(info: TokenInfo): string | null {
  if (info.type !== 'FungibleToken') return null;
  return info.content.total_supply.type;
}

function getCirculatingDisplay(info: TokenInfo, ticker: string): string | null {
  if (info.type !== 'FungibleToken') return null;
  const decimal = atomsToDecimal(info.content.circulating_supply.atoms, info.content.number_of_decimals);
  return `${decimal} ${ticker}`;
}

// ── Shared token card ──────────────────────────────────────────────────────────

interface TokenCardProps {
  tokenId: string;
  info: TokenInfo | null;
  explorerBase: string;
  isFavourite: boolean;
  onToggleFavourite: (tokenId: string, ticker: string) => void;
}

function TokenCard({ tokenId, info, explorerBase, isFavourite, onToggleFavourite }: TokenCardProps) {
  const isNFT = info?.type === 'NonFungibleToken';
  const ticker = !info ? '???' :
    isNFT ? (hexToText(info.content.metadata.ticker) ?? hexToText(info.content.metadata.name) ?? 'NFT') :
    (hexToText(info.content.token_ticker) ?? '???');
  const frozen = !isNFT && info?.type === 'FungibleToken' && info.content.frozen?.type === 'Frozen';
  const locked = !isNFT && info?.type === 'FungibleToken' && info.content.is_locked;
  const rawIconUrl = isNFT && info?.type === 'NonFungibleToken'
    ? (info.content.metadata.icon_uri?.text ?? null)
    : (info?.type === 'FungibleToken' ? (info.content.metadata_uri.text ?? null) : null);
  // Chain-controlled icon URLs must pass the image URI whitelist (https/ipfs/
  // data:image) — a raw https tracking pixel would leak every viewer's IP.
  const iconUrl = rawIconUrl ? safeImageUri(rawIconUrl) : null;
  const supplyType = info ? getSupplyType(info) : null;
  const circulatingDisplay = info ? getCirculatingDisplay(info, ticker) : null;

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          {iconUrl && (
            <img src={iconUrl} alt={ticker} width="28" height="28"
                 onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                 className="rounded-md object-cover shrink-0 border border-gray-700" />
          )}
          <span className="font-semibold text-gray-200">{ticker}</span>
          <TokenIdTooltip tokenId={tokenId} />
          {isNFT && (
            <span className="text-xs bg-purple-900/40 text-purple-300 border border-purple-800 rounded px-1.5 py-0.5">NFT</span>
          )}
          {supplyType && (
            <span className="text-xs bg-gray-800 text-gray-400 border border-gray-700 rounded px-1.5 py-0.5">{supplyType}</span>
          )}
          {frozen && (
            <span className="text-xs bg-blue-900/40 text-blue-300 border border-blue-800 rounded px-1.5 py-0.5">frozen</span>
          )}
          {locked && (
            <span className="text-xs bg-amber-900/40 text-amber-300 border border-amber-800 rounded px-1.5 py-0.5">locked</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onToggleFavourite(tokenId, ticker)}
            title={isFavourite ? 'Unpin from favourites' : 'Pin to favourites'}
            className="text-lg leading-none transition-colors"
            style={{ color: isFavourite ? '#eab308' : '#4b5563' }}
          >
            {isFavourite ? '★' : '☆'}
          </button>
          <a
            href={`${explorerBase}/token/${tokenId}`}
            target="_blank"
            rel="noopener"
            className="text-xs text-mint-400 hover:text-mint-300 transition-colors"
          >
            Explorer ↗
          </a>
        </div>
      </div>
      <span className="inline-flex items-center gap-1 flex-wrap mb-2">
        <span className="font-mono text-xs text-gray-500 break-all">{tokenId}</span>
        <CopyButton value={tokenId} title="Copy token ID" />
      </span>
      {info?.type === 'FungibleToken' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs text-gray-400">
          <span>Decimals: <span className="text-gray-200">{info.content.number_of_decimals}</span></span>
          {circulatingDisplay && (
            <span className="col-span-2 sm:col-span-2">
              Circulating: <span className="text-gray-200 font-mono">{circulatingDisplay}</span>
            </span>
          )}
        </div>
      )}
      {info?.type === 'NonFungibleToken' && info.content.metadata.description.text && (
        <p className="text-xs text-gray-400">{info.content.metadata.description.text}</p>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function TokenSearch({ network }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [indexerAvailable, setIndexerAvailable] = useState(true);
  const [favourites, setFavourites] = useState<FavouriteEntry[]>([]);
  const [favInfos, setFavInfos] = useState<Map<string, TokenInfo | null>>(new Map());
  const [favLoading, setFavLoading] = useState(false);

  // Verified-token bulk import state
  const [vtOpen, setVtOpen] = useState(false);
  const [vtRows, setVtRows] = useState<ExplorerTokenRow[] | null>(null);
  const [vtLoading, setVtLoading] = useState(false);
  const [vtError, setVtError] = useState<string | null>(null);
  const [vtSelected, setVtSelected] = useState<Set<string>>(new Set());
  const [vtImporting, setVtImporting] = useState(false);
  const [vtNote, setVtNote] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const explorerBase = network === 'testnet'
    ? 'https://lovelace.explorer.mintlayer.org'
    : 'https://explorer.mintlayer.org';

  useEffect(() => {
    fetch('/api/indexer-status')
      .then(r => r.json())
      .then((data: { up: boolean }) => setIndexerAvailable(data.up))
      .catch(() => {});

    fetch('/api/prefs')
      .then(r => r.json())
      .then((data: { ok: boolean; value?: FavouriteEntry[] }) => {
        const stored = data.ok ? (data.value ?? []) : [];
        setFavourites(stored);
        if (stored.length > 0) {
          fetchFavInfos(stored.map(f => f.tokenId));
        }
      })
      .catch(() => {});
  }, []);

  async function fetchFavInfos(ids: string[]) {
    if (ids.length === 0) return;
    setFavLoading(true);
    try {
      // Batched calls, aligned by each result's own token_id.
      setFavInfos(await getTokensInfoByIds(ids));
    } catch {
      // silently fail
    } finally {
      setFavLoading(false);
    }
  }

  async function toggleFavourite(tokenId: string, ticker: string) {
    const alreadyPinned = favourites.some(f => f.tokenId === tokenId);
    let next: FavouriteEntry[];
    if (alreadyPinned) {
      next = favourites.filter(f => f.tokenId !== tokenId);
    } else {
      if (favourites.length >= FAVOURITES_CAP) {
        setSaveError(`Your list is at its cap (${FAVOURITES_CAP}) — unpin something first.`);
        return;
      }
      next = [...favourites, { tokenId, ticker }];
    }
    // Persist first, then commit — the UI never claims a state the store
    // doesn't hold, and a later import can't overwrite a failed toggle.
    try {
      const res = await fetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? 'Saving failed');
    } catch (err) {
      setSaveError(`Could not save your list: ${(err as Error).message}`);
      return;
    }
    setSaveError(null);
    setFavourites(next);
    if (!alreadyPinned) {
      // Fetch fresh info for newly pinned token if not already cached
      setFavInfos(current => {
        if (!current.has(tokenId)) {
          const existing = results.find(r => r.tokenId === tokenId);
          if (existing) {
            const updated = new Map(current);
            updated.set(tokenId, existing.info);
            return updated;
          }
        }
        return current;
      });
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;

    setLoading(true);
    setError(null);
    setResults([]);
    setSearched(true);

    try {
      let tokenIds: string[] = [];

      if (looksLikeTokenId(q)) {
        tokenIds = [q.slice(0, 128)];
      } else {
        if (!indexerAvailable) {
          setError('Ticker search requires the indexer. Paste a full token ID to look up directly.');
          setLoading(false);
          return;
        }
        const res = await fetch(`/api/token-search?ticker=${encodeURIComponent(q)}`);
        const data = await res.json() as { ok: boolean; result?: string[]; error?: string };
        if (!data.ok) throw new Error(data.error ?? 'Search failed');
        tokenIds = data.result ?? [];
      }

      // Deduplicate and drop non-id junk before it reaches the RPC layer.
      tokenIds = [...new Set(tokenIds)].filter(
        id => typeof id === 'string' && id.length > 0 && id.length <= 128,
      );

      if (tokenIds.length === 0) {
        setLoading(false);
        return;
      }

      // Batched calls, aligned by each result's own token_id.
      const infoMap = await getTokensInfoByIds(tokenIds);
      setResults(tokenIds.map(id => ({ tokenId: id, info: infoMap.get(id) ?? null })));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const favSet = new Set(favourites.map(f => f.tokenId));

  async function loadVerified() {
    setVtOpen(true);
    setVtLoading(true);
    setVtError(null);
    setVtNote(null);
    try {
      const res = await fetch('/api/explorer-tokens');
      const data = await res.json() as { ok: boolean; tokens?: ExplorerTokenRow[]; error?: string };
      if (!data.ok) throw new Error(data.error ?? 'Could not load the verified token list');
      setVtRows(data.tokens ?? []);
      setVtSelected(new Set());
    } catch (err) {
      setVtError((err as Error).message);
    } finally {
      setVtLoading(false);
    }
  }

  async function importVerified() {
    if (!vtRows) return;
    const picked = vtRows.filter(r => vtSelected.has(r.tokenId));
    if (picked.length === 0) return;
    setVtImporting(true);
    setVtNote(null);
    try {
      const existing = new Set(favourites.map(f => f.tokenId));
      const additions = picked.filter(r => !existing.has(r.tokenId));
      const room = Math.max(0, FAVOURITES_CAP - favourites.length);
      const accepted = additions.slice(0, room);
      if (accepted.length === 0) {
        setVtNote('Nothing to import — these tokens are already in your list.');
        return;
      }
      const next: FavouriteEntry[] = [
        ...favourites,
        ...accepted.map(r => ({ tokenId: r.tokenId, ticker: r.ticker })),
      ];
      const res = await fetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? 'Saving failed');
      setFavourites(next);
      fetchFavInfos(next.map(f => f.tokenId));
      setVtNote(additions.length > accepted.length
        ? `Imported ${accepted.length} tokens — the list cap was reached.`
        : `Imported ${accepted.length} token${accepted.length === 1 ? '' : 's'}.`);
      setVtSelected(new Set());
    } catch (err) {
      setVtError((err as Error).message);
    } finally {
      setVtImporting(false);
    }
  }

  function toggleVtRow(tokenId: string) {
    setVtSelected(prev => {
      const next = new Set(prev);
      if (next.has(tokenId)) next.delete(tokenId);
      else next.add(tokenId);
      return next;
    });
  }

  function toggleVtAll() {
    if (!vtRows) return;
    setVtSelected(prev => (prev.size === vtRows.length ? new Set<string>() : new Set(vtRows.map(r => r.tokenId))));
  }

  return (
    <div>
      {/* ── Verified-token bulk import ───────────────────────────────── */}
      <div className="mb-4 rounded-lg border border-gray-800 bg-gray-900/60 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => (vtOpen ? setVtOpen(false) : void loadVerified())}
            disabled={vtLoading}
            className="rounded-lg bg-gray-800 hover:bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-200
                       transition-colors disabled:opacity-40"
          >
            {vtLoading ? 'Loading…' : vtOpen ? 'Hide verified tokens' : 'Browse verified tokens'}
          </button>
          <span className="text-xs text-gray-500">
            From the Mintlayer explorer's verified list — always check a token before trading it.
          </span>
        </div>

        {vtError && <p className="mt-2 text-xs text-red-300">{vtError}</p>}
        {saveError && <p className="mt-2 text-xs text-red-300">{saveError}</p>}
        {vtNote && <p className="mt-2 text-xs text-mint-300">{vtNote}</p>}

        {vtOpen && vtRows !== null && (
          vtRows.length === 0 ? (
            <p className="mt-2 text-xs text-gray-500">No verified tokens published yet.</p>
          ) : (
            <>
              <div className="mt-2 flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-gray-400">
                  <input
                    type="checkbox"
                    className="accent-mint-600"
                    checked={vtSelected.size === vtRows.length}
                    onChange={toggleVtAll}
                  />
                  Select all ({vtRows.length})
                </label>
                <button
                  type="button"
                  onClick={() => void importVerified()}
                  disabled={vtImporting || vtSelected.size === 0}
                  className="ml-auto rounded-lg bg-mint-700 hover:bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white
                             transition-colors disabled:opacity-40"
                >
                  {vtImporting ? 'Importing…' : `Import selected (${vtSelected.size})`}
                </button>
              </div>
              <ul className="mt-1 max-h-72 overflow-y-auto divide-y divide-gray-800">
                {vtRows.map(r => {
                  const checked = vtSelected.has(r.tokenId);
                  const already = favSet.has(r.tokenId);
                  return (
                    <li key={r.tokenId}>
                      <label className="flex min-h-[40px] cursor-pointer items-center gap-3 px-1 py-1.5 text-sm">
                        <input
                          type="checkbox"
                          className="accent-mint-600"
                          checked={checked}
                          onChange={() => toggleVtRow(r.tokenId)}
                        />
                        <span className="font-semibold text-gray-100">{r.ticker}</span>
                        {r.displayName && r.displayName !== r.ticker && (
                          <span className="truncate text-gray-400">{r.displayName}</span>
                        )}
                        {already && (
                          <span className="rounded border border-yellow-700 px-1 text-[10px] uppercase tracking-wide text-yellow-500">
                            listed
                          </span>
                        )}
                        {r.categories.length > 0 && (
                          <span className="ml-auto shrink-0 text-[11px] text-gray-500">
                            {r.categories.slice(0, 3).join(' · ')}
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )
        )}
      </div>

      {/* ── Search form ────────────────────────────────────────────────────── */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={indexerAvailable ? 'Ticker (e.g. MYTKN) or token ID…' : 'Token ID (mmltk1…)'}
          className="flex-1 rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder:text-gray-600
                     px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="rounded-lg bg-gray-700 hover:bg-gray-600 px-4 py-2 text-sm font-medium text-gray-200
                     transition-colors disabled:opacity-40 shrink-0"
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {!indexerAvailable && (
        <p className="text-xs text-gray-500 mt-2">
          Ticker search requires the indexer - only direct token ID lookup is available.
        </p>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-red-700 bg-red-900/30 p-3 text-red-300 text-sm">{error}</div>
      )}

      {searched && !loading && !error && results.length === 0 && (
        <p className="mt-3 text-sm text-gray-500">No tokens found.</p>
      )}

      {results.length > 0 && (
        <div className="mt-3 space-y-2">
          {results.map(({ tokenId, info }) => (
            <TokenCard
              key={tokenId}
              tokenId={tokenId}
              info={info}
              explorerBase={explorerBase}
              isFavourite={favSet.has(tokenId)}
              onToggleFavourite={toggleFavourite}
            />
          ))}
        </div>
      )}

      {/* ── Favourites section ─────────────────────────────────────────────── */}
      {favourites.length > 0 && (
        <div className="mt-6">
          <hr className="border-gray-800 mb-4" />
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-yellow-400">★ Favourites</h3>
            <button
              onClick={() => fetchFavInfos(favourites.map(f => f.tokenId))}
              disabled={favLoading}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40"
            >
              {favLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <div className="space-y-2">
            {favourites.map(({ tokenId, ticker }) => {
              const info = favInfos.get(tokenId) ?? null;
              return (
                <TokenCard
                  key={tokenId}
                  tokenId={tokenId}
                  info={info}
                  explorerBase={explorerBase}
                  isFavourite={true}
                  onToggleFavourite={toggleFavourite}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
