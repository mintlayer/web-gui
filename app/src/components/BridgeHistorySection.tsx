import { useCallback, useEffect, useState } from 'react';
import {
  createBridgeSdk,
  deriveProgress,
  isEthTxHash,
  isTxHashLike,
  type BridgeRequestDetail,
} from '@/lib/bridge-sdk';
import { ethExplorerBase, mlExplorerBase } from '@/lib/bridge-sdk/explorers';
import {
  listHistory,
  updateHistoryStatus,
  type BridgeHistoryEntry,
} from '@/lib/bridge-sdk/bridge-history';

/**
 * "Your recent bridges" — the local (per-browser) history of the user's
 * own bridge requests, with live status refresh for open rows and
 * explorer links for both legs. All storage access is fail-closed.
 */

const sdk = createBridgeSdk();

const card =
  'rounded-2xl border border-gray-800 bg-gray-950 p-4 sm:p-6';

function statusChip(kind: string, status: string | undefined): { label: string; cls: string } {
  if (kind === 'completed') return { label: 'Completed', cls: 'border-mint-700 text-mint-300' };
  if (kind === 'failed') return { label: 'Failed', cls: 'border-red-800 text-red-300' };
  if (kind === 'manual') return { label: 'Manual review', cls: 'border-amber-800 text-amber-300' };
  return { label: status || 'In progress', cls: 'border-gray-700 text-gray-300' };
}

function Row({
  entry,
  networkType,
  flavor,
}: {
  entry: BridgeHistoryEntry;
  networkType: string;
  flavor: string;
}) {
  const [detail, setDetail] = useState<BridgeRequestDetail | null>(null);
  const [kind, setKind] = useState<string>('in-progress');
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await sdk.getBridgeRequest(entry.uuid);
      const p = deriveProgress(d);
      setDetail(d);
      setKind(p.kind);
      setFailed(false);
      updateHistoryStatus(entry.uuid, p.rawStatus);
    } catch {
      setFailed(true);
    }
  }, [entry.uuid]);

  useEffect(() => {
    if (open && !detail && !failed) void load();
  }, [open, detail, failed, load]);

  const chip = statusChip(kind, entry.status);
  const depositHash = detail
    ? deriveProgress(detail).depositTxHash
    : null;
  const payoutHash = detail ? deriveProgress(detail).mlTxHash : null;

  return (
    <li className="border-b border-gray-800 last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[44px] w-full flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2 text-left text-sm text-gray-300 hover:text-gray-100"
      >
        <span className="font-mono text-xs text-gray-500">
          {new Date(entry.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </span>
        <span className="text-xs text-gray-500">
          {entry.direction === 'e2m' ? 'ETH → ML' : 'ML → ETH'}
        </span>
        <span className="font-medium">
          {entry.amount} {entry.asset}
        </span>
        <span className={`ml-auto rounded border px-1.5 py-0.5 text-[10px] ${chip.cls}`}>
          {chip.label}
        </span>
        <span aria-hidden="true" className="text-gray-600">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="px-1 pb-3 text-xs text-gray-400">
          <p className="font-mono break-all">receiver {entry.receiver}</p>
          <p className="font-mono break-all">request {entry.uuid}</p>
          {failed && (
            <p className="mt-1 text-red-300">
              Couldn&apos;t load the current status.{' '}
              <button type="button" onClick={() => void load()} className="underline">
                Retry
              </button>
            </p>
          )}
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {depositHash && isEthTxHash(depositHash) && (
              <a
                href={`${ethExplorerBase(flavor)}/tx/${depositHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-mint-300 underline hover:opacity-80"
              >
                Deposit on Etherscan ↗
              </a>
            )}
            {payoutHash && isTxHashLike(payoutHash) && (
              <a
                href={`${mlExplorerBase(networkType)}/transaction/${payoutHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-mint-300 underline hover:opacity-80"
              >
                Payout on the Mintlayer explorer ↗
              </a>
            )}
          </p>
        </div>
      )}
    </li>
  );
}

export default function BridgeHistorySection({
  refreshToken,
  networkType,
  flavor,
}: {
  refreshToken: number;
  networkType: string;
  flavor: string;
}) {
  const [entries, setEntries] = useState<BridgeHistoryEntry[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setEntries(listHistory());
  }, [refreshToken]);

  if (entries.length === 0) return null;

  return (
    <div className={card}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
        className="flex min-h-[44px] w-full items-center justify-between text-left"
      >
        <h2 className="text-base font-semibold text-gray-100">
          Your recent bridges ({entries.length})
        </h2>
        <span aria-hidden="true" className="text-gray-500 text-sm">
          {expanded ? '▴' : '▾'}
        </span>
      </button>
      {expanded && (
        <ul className="mt-2">
          {entries.map((e) => (
            <Row key={e.uuid} entry={e} networkType={networkType} flavor={flavor} />
          ))}
        </ul>
      )}
    </div>
  );
}
