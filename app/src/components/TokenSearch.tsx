import { useState, useEffect } from 'react';
import type { TokenInfo } from '@/lib/wallet-rpc';
import { hexToText } from '@/lib/token-utils';
import { CopyButton } from '@/components/CopyButton';
import { TokenIdTooltip } from '@/components/TokenIdTooltip';

interface SearchResult {
  tokenId: string;
  info: TokenInfo | null;
}

interface FavouriteEntry {
  tokenId: string;
  ticker: string;
}

interface Props {
  network: string;
}

async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const data = await res.json() as { ok: boolean; result?: T; error?: { message: string } };
  if (!data.ok) throw new Error(data.error?.message ?? 'RPC error');
  return data.result as T;
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
  const iconUrl = isNFT && info?.type === 'NonFungibleToken'
    ? (info.content.metadata.icon_uri?.text ?? null)
    : (info?.type === 'FungibleToken' ? (info.content.metadata_uri.text ?? null) : null);
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
      // node_get_tokens_info does not preserve input order — call one at a time so
      // each result is guaranteed to correspond to the correct token ID.
      const results = await Promise.all(
        ids.map(id =>
          rpc<(TokenInfo | null)[]>('node_get_tokens_info', { token_ids: [id] })
            .then(([info]) => ({ id, info: info ?? null }))
        )
      );
      const map = new Map<string, TokenInfo | null>();
      results.forEach(({ id, info }) => map.set(id, info));
      setFavInfos(map);
    } catch {
      // silently fail
    } finally {
      setFavLoading(false);
    }
  }

  function toggleFavourite(tokenId: string, ticker: string) {
    setFavourites(prev => {
      const alreadyPinned = prev.some(f => f.tokenId === tokenId);
      const next = alreadyPinned
        ? prev.filter(f => f.tokenId !== tokenId)
        : [...prev, { tokenId, ticker }];
      fetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      }).catch(() => {});

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

      return next;
    });
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
        tokenIds = [q];
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

      // Deduplicate
      tokenIds = [...new Set(tokenIds)];

      if (tokenIds.length === 0) {
        setLoading(false);
        return;
      }

      // node_get_tokens_info does not preserve input order — call one at a time.
      const infoResults = await Promise.all(
        tokenIds.map(id =>
          rpc<(TokenInfo | null)[]>('node_get_tokens_info', { token_ids: [id] })
            .then(([info]) => ({ id, info: info ?? null }))
        )
      );
      setResults(infoResults.map(({ id, info }) => ({ tokenId: id, info })));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const favSet = new Set(favourites.map(f => f.tokenId));

  return (
    <div>
      {/* ── Favourites section ─────────────────────────────────────────────── */}
      {favourites.length > 0 && (
        <div className="mb-6">
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
              const displayInfo: TokenInfo | null = info ?? null;
              return (
                <TokenCard
                  key={tokenId}
                  tokenId={tokenId}
                  info={displayInfo}
                  explorerBase={explorerBase}
                  isFavourite={true}
                  onToggleFavourite={toggleFavourite}
                />
              );
            })}
          </div>
          <hr className="border-gray-800 mt-4" />
        </div>
      )}

      {/* ── Search form ────────────────────────────────────────────────────── */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={indexerAvailable ? 'Ticker (e.g. MYTKN) or token ID…' : 'Token ID (mmltk1…)'}
          className="flex-1 rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600
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
          Ticker search requires the indexer — only direct token ID lookup is available.
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
    </div>
  );
}
