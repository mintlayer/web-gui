import { useState, useEffect, useRef, useMemo, useCallback } from 'react';

export interface NavItem {
  key: string;
  label: string;
  href: string;
  section: string;
}

interface Props {
  items: NavItem[];
}

function fuzzyMatch(q: string, t: string): boolean {
  q = q.toLowerCase();
  t = t.toLowerCase();
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

const RECENT_KEY = 'recently_visited';
const MAX_RECENT = 5;

export default function CommandPalette({ items }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentRoutes, setRecentRoutes] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Record current page visit on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const prev: string[] = raw ? JSON.parse(raw) : [];
      const current = window.location.pathname;
      const updated = [current, ...prev.filter(r => r !== current)].slice(0, MAX_RECENT);
      localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
      setRecentRoutes(updated);
    } catch {
      // ignore localStorage errors
    }
  }, []);

  // Listen for global Cmd+K and cp:open event
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('cp:open', onOpen);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('cp:open', onOpen);
    };
  }, []);

  // Focus input when opened, reset state
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const displayItems = useMemo(() => {
    if (!query.trim()) {
      const recent = recentRoutes
        .map(route => items.find(i => i.href === route || (route.startsWith(i.href) && i.href !== '/')))
        .filter((x): x is NavItem => x !== undefined);
      // Deduplicate
      const seen = new Set<string>();
      return recent.filter(i => seen.has(i.key) ? false : (seen.add(i.key), true));
    }
    return items.filter(
      item => fuzzyMatch(query, item.label) || fuzzyMatch(query, item.section)
    );
  }, [query, items, recentRoutes]);

  const grouped = useMemo(() => {
    const result: Record<string, NavItem[]> = {};
    for (const item of displayItems) {
      (result[item.section] ??= []).push(item);
    }
    return result;
  }, [displayItems]);

  // Flat ordered list for keyboard nav
  const flat = useMemo(() => displayItems, [displayItems]);

  const navigate = useCallback((item: NavItem) => {
    setOpen(false);
    window.location.href = item.href;
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const item = flat[selectedIndex];
      if (item) navigate(item);
    }
  };

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!open) return null;

  const sectionOrder = ['WALLET', 'ASSETS', 'TRADE', 'PLUGINS'];
  const sections = [
    ...sectionOrder.filter(s => grouped[s]),
    ...Object.keys(grouped).filter(s => !sectionOrder.includes(s)),
  ];

  let flatIdx = 0;
  const sectionItems = sections.map(section => {
    const sectionNavItems = grouped[section].map(item => {
      const idx = flatIdx++;
      return { item, idx };
    });
    return { section, items: sectionNavItems };
  });

  const emptyState = flat.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onKeyDown={onKeyDown}
      onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />

      {/* Modal */}
      <div className="relative w-full max-w-lg mx-4 bg-gray-900 border border-gray-700 rounded-lg shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
          <svg
            className="w-4 h-4 text-gray-500 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="cp-listbox"
            aria-activedescendant={flat[selectedIndex] ? `cp-option-${selectedIndex}` : undefined}
            placeholder="Go to..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-gray-100 placeholder-gray-500 text-sm outline-none"
          />
          <kbd className="text-xs text-gray-600 border border-gray-700 rounded px-1.5 py-0.5 font-mono">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          id="cp-listbox"
          role="listbox"
          className="max-h-80 overflow-y-auto py-2"
        >
          {!query.trim() && flat.length > 0 && (
            <p className="px-4 pb-1 text-xs text-gray-600 uppercase tracking-wider">Recent</p>
          )}
          {emptyState && (
            <p className="px-4 py-6 text-center text-sm text-gray-500">No results found.</p>
          )}
          {sectionItems.map(({ section, items: sectionNavItems }) => (
            <div key={section} role="group" aria-label={section}>
              {query.trim() && (
                <p className="px-4 pt-2 pb-1 text-xs text-gray-600 uppercase tracking-wider">
                  {section}
                </p>
              )}
              {sectionNavItems.map(({ item, idx }) => (
                <button
                  key={item.key}
                  id={`cp-option-${idx}`}
                  role="option"
                  aria-selected={idx === selectedIndex}
                  data-idx={idx}
                  onClick={() => navigate(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={[
                    'w-full flex items-center gap-3 px-4 py-2 text-sm transition-colors text-left',
                    idx === selectedIndex
                      ? 'bg-mint-600/20 text-mint-400'
                      : 'text-gray-300 hover:bg-gray-800',
                  ].join(' ')}
                >
                  <span className="flex-1">{item.label}</span>
                  <span className="text-xs text-gray-600">{item.section}</span>
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div className="border-t border-gray-800 px-4 py-2 flex items-center gap-4 text-xs text-gray-600">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> go</span>
          <span><kbd className="font-mono">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
