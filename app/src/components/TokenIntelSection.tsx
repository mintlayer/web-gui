/**
 * TokenIntelSection - supply statistics + top holders for a token,
 * backed by the 1.4.1 indexer /statistics endpoints (via /api/token-intel).
 * Collapsible so the manage panel stays lean; fetches on first expand.
 */

import { useState } from 'react';
import { CopyButton } from '@/components/CopyButton';

interface IndexerAmount {
  atoms: string;
  decimal: string;
}

interface TokenIntel {
  ok: true;
  statistics: {
    circulating_supply: IndexerAmount;
    preminted: IndexerAmount;
    burned: IndexerAmount;
    staked: IndexerAmount;
  };
  holders: { address: string; amount: IndexerAmount }[];
  moreHolders: boolean;
}

type IntelState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'ready'; data: TokenIntel };

function shortAddress(addr: string): string {
  return addr.length > 18 ? `${addr.slice(0, 10)}…${addr.slice(-6)}` : addr;
}

function explorerTokenUrl(tokenId: string): string {
  const network = typeof document !== 'undefined'
    ? (document.body.dataset['network'] ?? 'mainnet')
    : 'mainnet';
  const base = network === 'testnet'
    ? 'https://lovelace.explorer.mintlayer.org'
    : 'https://explorer.mintlayer.org';
  return `${base}/token/${tokenId}`;
}

const REASONS: Record<string, string> = {
  'indexer-unavailable': 'The indexer is not reachable right now.',
  'requires-1.4.1': 'Supply statistics and holder listings need a v1.4.1 or newer indexer.',
  'indexer-request-failed': 'The indexer could not answer this request (token may have no holder data).',
};

export default function TokenIntelSection({ tokenId, ticker }: { tokenId: string; ticker: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<IntelState>({ kind: 'idle' });

  const load = async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch(`/api/token-intel?token_id=${encodeURIComponent(tokenId)}`);
      if (res.status === 401) {
        setState({ kind: 'unsupported', reason: 'Session expired - reload the page.' });
        return;
      }
      const body = await res.json();
      if (!body.ok) {
        setState({ kind: 'unsupported', reason: REASONS[body.reason] ?? 'Not available right now.' });
        return;
      }
      setState({ kind: 'ready', data: body as TokenIntel });
    } catch {
      setState({ kind: 'unsupported', reason: 'The indexer is not reachable right now.' });
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && state.kind === 'idle') void load();
  };

  const statRow = (label: string, value: IndexerAmount | undefined) => (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="font-mono text-gray-200">
        {value ? Number(value.decimal).toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—'} {ticker}
      </span>
    </div>
  );

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-800/40 hover:bg-gray-800/60 transition-colors text-left"
      >
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Supply statistics &amp; holders
        </span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5"
          className={`text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="px-4 py-3 space-y-3">
          {state.kind === 'loading' && <p className="text-sm text-gray-500">Loading chain statistics…</p>}

          {state.kind === 'unsupported' && (
            <p className="text-sm text-gray-400">{state.reason}</p>
          )}

          {state.kind === 'ready' && (
            <>
              <div className="text-sm space-y-1.5">
                {statRow('Circulating', state.data.statistics.circulating_supply)}
                {statRow('Preminted', state.data.statistics.preminted)}
                {statRow('Burned', state.data.statistics.burned)}
                {statRow('Staked in pools', state.data.statistics.staked)}
              </div>

              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wider mb-1.5">Top holders</div>
                {state.data.holders.length === 0 ? (
                  <p className="text-sm text-gray-500">No holder balances reported.</p>
                ) : (
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-gray-800/60">
                      {state.data.holders.map((h) => (
                        <tr key={h.address}>
                          <td className="py-1.5 pr-2 font-mono text-xs text-gray-300">
                            <span className="inline-flex items-center gap-1">
                              {shortAddress(h.address)}
                              <CopyButton value={h.address} title="Copy holder address" />
                            </span>
                          </td>
                          <td className="py-1.5 text-right font-mono text-gray-200">
                            {Number(h.amount.decimal).toLocaleString('en-US', { maximumFractionDigits: 8 })} {ticker}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {state.data.moreHolders && (
                  <p className="mt-1.5 text-xs text-gray-500">
                    Showing the top {state.data.holders.length} ·{' '}
                    <a
                      href={explorerTokenUrl(tokenId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-mint-400 hover:text-mint-300 underline"
                    >
                      all holders on the explorer
                    </a>
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
