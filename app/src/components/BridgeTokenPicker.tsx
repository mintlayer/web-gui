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
  disabled?: boolean;
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
  return (
    <img
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

export default function BridgeTokenPicker({ assets, value, onChange, metadata, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  const selected = assets.find((a) => a.ticker === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter(
      (a) =>
        a.ticker.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [assets, query]);

  // The highlight index must stay inside the filtered list — typing can
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
                  {a.ticker === value && (
                    <span aria-hidden="true" className="ml-auto text-xs text-mint-400">✓</span>
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
