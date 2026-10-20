import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { TokenMetadata } from '@/lib/bridge-sdk';
import { safeImageUri } from '@/lib/safe-uri';

/**
 * Searchable token picker for bridge assets (combobox pattern).
 * Filters by ticker and metadata name/tag; full keyboard support
 * (↑/↓ move, Enter selects, Esc closes) with aria-activedescendant.
 */

export interface PickerAsset {
  ticker: string;
  name: string;
  tags: string[];
}

interface Props {
  assets: PickerAsset[];
  value: string;
  onChange: (ticker: string) => void;
  /** Resolved display metadata by ticker (drives icons). */
  metadata: Record<string, TokenMetadata | null>;
  /** Connected-wallet balance by ticker (decimal string or null). */
  balances?: Record<string, string | null>;
  /** USD spot price by ticker; drives holdings-first ordering. */
  usdPrices?: Record<string, number | null>;
  disabled?: boolean;
}

const NO_BALANCES: Record<string, string | null> = Object.create(null);
const NO_PRICES: Record<string, number | null> = Object.create(null);

function parseBalance(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function compactUsd(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(2)}`;
}

/** Holdings first (by USD value), then the rest alphabetically. */
function byHoldings(
  balances: Record<string, string | null>,
  usdPrices: Record<string, number | null>,
) {
  const group = (t: string): number => {
    const b = parseBalance(balances[t]);
    return b !== null && b > 0 ? 0 : 1;
  };
  const usd = (t: string): number | null => {
    const b = parseBalance(balances[t]);
    const p = usdPrices[t];
    return b !== null && typeof p === 'number' ? b * p : null;
  };
  return (x: PickerAsset, y: PickerAsset): number => {
    const gx = group(x.ticker) - group(y.ticker);
    if (gx !== 0) return gx;
    const vx = usd(x.ticker);
    const vy = usd(y.ticker);
    if (vx !== null && vy !== null && vx !== vy) return vy - vx;
    if (vx === null && vy !== null) return 1;
    if (vy === null && vx !== null) return -1;
    return x.ticker.localeCompare(y.ticker);
  };
}

const input =
  'w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-mint-600 focus:outline-none';

function TokenIcon({ metadata, ticker }: { metadata: TokenMetadata | null; ticker: string }) {
  const [broken, setBroken] = useState(false);
  const src = metadata?.icon ? safeImageUri(metadata.icon) : null;
  if (!src || broken) {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-800 text-[10px] font-bold text-gray-300">
        {ticker.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  // Key by src: when one token's icon 404s, a different token rendered
  // by the same instance (picker switch) must retry the image.
  return (
    <img
      key={src}
      src={src}
      alt=""
      width={24}
      height={24}
      loading="lazy"
      onError={() => setBroken(true)}
      className="h-6 w-6 shrink-0 rounded-full object-contain"
    />
  );
}

export default function BridgeTokenPicker({
  assets,
  value,
  onChange,
  metadata,
  balances = NO_BALANCES,
  usdPrices = NO_PRICES,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  const selected = assets.find((a) => a.ticker === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q
      ? assets.filter(
          (a) =>
            a.ticker.toLowerCase().includes(q) ||
            a.name.toLowerCase().includes(q) ||
            a.tags.some((t) => t.toLowerCase().includes(q)),
        )
      : assets;
    return [...hits].sort(byHoldings(balances, usdPrices));
  }, [assets, query, balances, usdPrices]);

  // The highlight index must stay inside the filtered list - typing can
  // shrink it while a higher index is active.
  const activeIdx = Math.min(active, Math.max(filtered.length - 1, 0));

  useEffect(() => {
    if (!open) return;
    setActive(0);
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function pick(ticker: string) {
    onChange(ticker);
    setOpen(false);
    setQuery('');
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = filtered[activeIdx];
      if (hit) pick(hit.ticker);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className={`${input} flex items-center gap-2 text-left`}
      >
        {selected ? (
          <>
            <PickerIcon ticker={selected.ticker} metadata={metadata} />
            <span className="font-medium">{selected.ticker}</span>
            {selected.name && selected.name !== selected.ticker && (
              <span className="truncate text-xs text-gray-500">{selected.name}</span>
            )}
          </>
        ) : (
          <span className="text-gray-500">Select a token…</span>
        )}
        <span aria-hidden="true" className="ml-auto text-gray-500">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-800 bg-gray-900 shadow-xl">
          <input
            ref={searchRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={filtered[activeIdx] ? `${listId}-opt-${activeIdx}` : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or tag…"
            className="w-full rounded-t-lg border-b border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none"
          />
          <ul id={listId} role="listbox" aria-label="Bridge assets" className="max-h-56 overflow-y-auto p-1">
            {filtered.map((a, idx) => (
              <li key={a.ticker} id={`${listId}-opt-${idx}`} role="option" aria-selected={a.ticker === value}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => pick(a.ticker)}
                  className={`flex w-full min-h-[44px] items-center gap-2 rounded-md px-2 py-2 text-left text-sm ${
                    idx === activeIdx ? 'bg-mint-900/40 text-mint-200' : 'text-gray-200'
                  }`}
                >
                  <PickerIcon ticker={a.ticker} metadata={metadata} />
                  <span className="font-medium">{a.ticker}</span>
                  {a.name && a.name !== a.ticker && (
                    <span className="truncate text-xs text-gray-500">{a.name}</span>
                  )}
                  {(() => {
                    const b = parseBalance(balances[a.ticker]);
                    if (b === null) return null;
                    const p = usdPrices[a.ticker];
                    const v = typeof p === 'number' ? b * p : null;
                    return (
                      <span className="ml-auto text-right text-xs leading-tight">
                        <span className="block text-gray-300">
                          {b.toLocaleString(undefined, { maximumFractionDigits: 8 })}
                        </span>
                        {v !== null && (
                          <span className="block text-gray-500">≈{compactUsd(v)}</span>
                        )}
                      </span>
                    );
                  })()}
                  {a.ticker === value && (
                    <span
                      aria-hidden="true"
                      className={`${parseBalance(balances[a.ticker]) === null ? 'ml-auto ' : ''}text-xs text-mint-400`}
                    >
                      ✓
                    </span>
                  )}
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-3 py-3 text-sm text-gray-500" aria-live="polite">
                No tokens match “{query}”.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function PickerIcon({
  ticker,
  metadata,
}: {
  ticker: string;
  metadata: Record<string, TokenMetadata | null>;
}) {
  return <TokenIcon metadata={metadata[ticker] ?? null} ticker={ticker} />;
}
