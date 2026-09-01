"use client";

import { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { CopyButton } from '@/components/CopyButton';

// ── Types (mirror of the sidecar payloads) ────────────────────────────────────

interface BitcoinNodeInfo {
  reachable: boolean;
  blocks: number;
  headers: number;
  synced: boolean;
  initialBlockDownload: boolean;
}

interface BitcoinStatus {
  network: string;
  walletExists: boolean;
  walletLoaded: boolean;
  node: BitcoinNodeInfo;
  balance: { confirmed: string; trustedPending: string; untrustedPending: string; immature: string } | null;
}

interface BitcoinTransaction {
  txid: string;
  received: string;
  sent: string;
  fee: string | null;
  confirmed: boolean;
  height: number | null;
  timestamp: number | null;
}

interface Overview {
  status: BitcoinStatus | null;
  address: string | null;
  balance: { confirmed: string; trustedPending: string; untrustedPending: string; immature: string } | null;
  transactions: BitcoinTransaction[] | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await res.json() as T & { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** Format satoshi amount as BTC with at most 8 decimals, no float math. */
function satsToBtc(sats: string | bigint): string {
  const n = BigInt(sats);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 100_000_000n;
  const frac = (abs % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : '0'}`;
}

const card = 'bg-gray-900 border border-gray-800 rounded-xl p-6';
const input = 'w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600';
const primaryBtn = 'rounded-lg bg-mint-700 hover:bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-50';

// ── Component ─────────────────────────────────────────────────────────────────

export default function BitcoinWallet() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [newMnemonic, setNewMnemonic] = useState<string[] | null>(null);
  const [seedConfirmed, setSeedConfirmed] = useState(false);

  // Send form
  const [sendTo, setSendTo] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentTxid, setSentTxid] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoadError(null);
      setOverview(await api<Overview>('/api/bitcoin/overview'));
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const walletExists = overview?.status?.walletExists ?? false;

  // ── Create / restore wallet ─────────────────────────────────────────────────

  async function createWallet(seed?: string) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await api<{ mnemonic?: string }>('/api/bitcoin/wallet', {
        method: 'POST',
        body: JSON.stringify({ seed: seed ?? null }),
      });
      setSeedConfirmed(false);
      setNewMnemonic((res.mnemonic ?? '').split(/\s+/).filter(Boolean));
      await refresh();
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function restoreWallet() {
    const input = window.prompt('Enter your 12-word recovery phrase');
    if (!input) return;
    createWallet(input.trim());
  }

  // ── Sync ────────────────────────────────────────────────────────────────────

  async function triggerSync() {
    setBusy(true);
    try {
      await api('/api/bitcoin/sync', { method: 'POST' });
      setNotice('Sync started - balances refresh in a few seconds.');
      setTimeout(refresh, 5000);
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ── Send ────────────────────────────────────────────────────────────────────

  async function submitSend(e: React.FormEvent) {
    e.preventDefault();
    setSendError(null);
    setSentTxid(null);
    if (!sendAmount.trim() || !sendTo.trim()) {
      setSendError('Address and amount are required.');
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ txid: string }>('/api/bitcoin/send', {
        method: 'POST',
        body: JSON.stringify({ address: sendTo.trim(), amount_btc: sendAmount.trim() }),
      });
      setSentTxid(res.txid);
      setSendTo('');
      setSendAmount('');
      setTimeout(refresh, 4000);
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loadError) {
    return <div className={card}><p className="text-sm text-red-400">{loadError}</p></div>;
  }
  if (!overview) {
    return <div className={card}><p className="text-sm text-gray-500">Loading…</p></div>;
  }

  const node = overview.status?.node;
  const offline = !overview.status || !node?.reachable;
  const balance = overview.balance;

  return (
    <div className="space-y-6">
      {/* Hot wallet warning */}
      <div className="rounded-lg border border-amber-800 bg-amber-900/20 px-4 py-3 text-amber-300 text-xs">
        BTC funds are held by a <span className="font-semibold">hot wallet</span> on this machine.
        Keep only spending amounts here and back up your seed phrase.
      </div>

      {/* Node status strip */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-400">
        <span className="inline-flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${offline ? 'bg-red-500' : node?.synced ? 'bg-mint-400' : 'bg-yellow-400 animate-pulse'}`} />
          {offline
            ? 'Node offline'
            : node!.synced
              ? `Node synced (#${node!.blocks.toLocaleString()})`
              : `Syncing… #${node!.blocks.toLocaleString()} / #${node!.headers.toLocaleString()}`}
        </span>
        {overview.status && (
          <span className="uppercase tracking-wider text-gray-500">{overview.status.network}</span>
        )}
        <button onClick={refresh} disabled={busy} className="ml-auto text-mint-400 hover:text-mint-300 disabled:opacity-50">
          Refresh
        </button>
        {walletExists && (
          <button onClick={triggerSync} disabled={busy} className="text-mint-400 hover:text-mint-300 disabled:opacity-50">
            Sync wallet
          </button>
        )}
      </div>

      {offline && (
        <div className={card}>
          <h2 className="text-base font-semibold text-gray-100 mb-2">Bitcoin node is not running</h2>
          <p className="text-sm text-gray-400 mb-3">
            Start the optional Bitcoin stack from the host:
          </p>
          <code className="block rounded bg-gray-800 px-3 py-2 text-xs font-mono text-mint-400">
            docker compose --profile bitcoin up -d
          </code>
        </div>
      )}

      {notice && (
        <div className="rounded-lg border border-mint-700 bg-mint-900/20 px-4 py-3 text-mint-300 text-sm">{notice}</div>
      )}

      {/* ── No wallet yet ─────────────────────────────────────────────────────── */}
      {overview.status && !walletExists && !newMnemonic && (
        <div className={card}>
          <h2 className="text-base font-semibold text-gray-100 mb-2">Create your BTC wallet</h2>
          <p className="text-sm text-gray-400 mb-5">
            A new wallet generates a 12-word seed phrase. You can also restore an existing wallet.
          </p>
          <div className="flex gap-3">
            <button onClick={() => createWallet()} disabled={busy} className={primaryBtn}>Create new wallet</button>
            <button onClick={restoreWallet} disabled={busy} className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 transition-colors disabled:opacity-50">
              Restore from seed
            </button>
          </div>
        </div>
      )}

      {/* ── One-time seed display ─────────────────────────────────────────────── */}
      {newMnemonic && (
        <div className={card}>
          <h2 className="text-base font-semibold text-gray-100 mb-2">Back up your seed phrase</h2>
          <p className="text-sm text-gray-400 mb-4">
            Write these 12 words down and keep them safe. <span className="text-red-400 font-semibold">They are shown only once</span> and
            are the only way to recover your BTC wallet.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-5">
            {newMnemonic.map((word, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg bg-gray-800 border border-gray-700 px-3 py-2">
                <span className="text-xs text-gray-500 w-4">{i + 1}</span>
                <span className="text-sm font-mono text-gray-100">{word}</span>
              </div>
            ))}
          </div>
          <label className="flex items-center gap-2 mb-4 cursor-pointer select-none">
            <input type="checkbox" checked={seedConfirmed} onChange={e => setSeedConfirmed(e.target.checked)} className="rounded accent-mint-500" />
            <span className="text-sm text-gray-300">I have written down my seed phrase</span>
          </label>
          <button onClick={() => { setNewMnemonic(null); refresh(); }} disabled={!seedConfirmed} className={primaryBtn}>
            Continue
          </button>
        </div>
      )}

      {/* ── Wallet ────────────────────────────────────────────────────────────── */}
      {overview.status && walletExists && (
        <>
          {/* Balance */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className={card}>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Confirmed</p>
              <p className="text-2xl font-semibold text-gray-100">
                {balance ? satsToBtc(balance.confirmed) : '—'} <span className="text-sm font-normal text-gray-500">BTC</span>
              </p>
            </div>
            <div className={card}>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Pending</p>
              <p className="text-2xl font-semibold text-yellow-400">
                {balance ? satsToBtc(BigInt(balance.trustedPending) + BigInt(balance.untrustedPending)) : '—'} <span className="text-sm font-normal text-gray-500">BTC</span>
              </p>
            </div>
            <div className={card}>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Immature</p>
              <p className="text-2xl font-semibold text-gray-400">
                {balance ? satsToBtc(balance.immature) : '—'} <span className="text-sm font-normal text-gray-500">BTC</span>
              </p>
            </div>
          </div>

          {/* Receive + Send */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className={card}>
              <h2 className="text-base font-semibold text-gray-100 mb-4">Receive</h2>
              {overview.address ? (
                <div className="flex flex-col items-center gap-4">
                  <QRCodeSVG value={overview.address} size={148} bgColor="#111827" fgColor="#e5e7eb" />
                  <code className="block rounded bg-gray-800 px-3 py-2 text-xs font-mono text-mint-400 break-all text-center">
                    {overview.address}
                  </code>
                  <CopyButton value={overview.address} title="Copy address" />
                </div>
              ) : (
                <p className="text-sm text-gray-500">Wallet is loading…</p>
              )}
            </div>

            <div className={card}>
              <h2 className="text-base font-semibold text-gray-100 mb-4">Send</h2>
              {sentTxid && (
                <div className="mb-4 px-3 py-2 rounded-lg border border-emerald-800 bg-emerald-950/50 text-emerald-300 text-sm">
                  Sent! Transaction <code className="font-mono text-xs break-all">{sentTxid}</code>
                </div>
              )}
              {sendError && (
                <div className="mb-4 px-3 py-2 rounded-lg border border-red-800 bg-red-950/50 text-red-300 text-sm">{sendError}</div>
              )}
              <form onSubmit={submitSend} className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">To address</label>
                  <input value={sendTo} onChange={e => setSendTo(e.target.value)} placeholder="bc1…" className={input} required />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Amount (BTC)</label>
                  <input
                    value={sendAmount}
                    onChange={e => setSendAmount(e.target.value)}
                    placeholder="0.005"
                    inputMode="decimal"
                    pattern="\d{1,8}(\.\d{1,8})?"
                    className={input}
                    required
                  />
                </div>
                <button type="submit" disabled={busy} className={`${primaryBtn} w-full`}>
                  {busy ? 'Signing…' : 'Send'}
                </button>
              </form>
            </div>
          </div>

          {/* Transactions */}
          <div className={card}>
            <h2 className="text-base font-semibold text-gray-100 mb-4">Transactions</h2>
            {!overview.transactions || overview.transactions.length === 0 ? (
              <p className="text-sm text-gray-500">No transactions yet.</p>
            ) : (
              <div className="divide-y divide-gray-800">
                {overview.transactions.map(tx => {
                  const received = BigInt(tx.received) > BigInt(tx.sent);
                  const amount = BigInt(tx.received) - BigInt(tx.sent);
                  return (
                    <div key={tx.txid} className="flex items-center justify-between py-2.5 gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-gray-200">
                          {received ? '+' : ''} {satsToBtc(amount.toString())} BTC
                        </p>
                        <p className="text-xs text-gray-500 font-mono truncate">{tx.txid}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`text-xs ${tx.confirmed ? 'text-gray-400' : 'text-yellow-400'}`}>
                          {tx.confirmed ? 'Confirmed' : 'Pending'}
                        </p>
                        {tx.height !== null && <p className="text-xs text-gray-600">#{tx.height.toLocaleString()}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
