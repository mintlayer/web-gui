"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { CopyButton } from '@/components/CopyButton';
import AddressSuggestion from '@/components/AddressSuggestion';
import SeedBackupStep from '@/components/SeedBackupStep';
import { suggestAddressCorrection, hrpForNetwork } from '@/lib/bech32-correct';
import type {
  BitcoinStatus,
  BitcoinTransaction,
  BitcoinBalance,
} from '@/lib/bitcoin-wallet';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Overview {
  status: BitcoinStatus | null;
  address: string | null;
  balance: BitcoinBalance | null;
  transactions: BitcoinTransaction[] | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  // Auth expiry and proxy errors return the login HTML or a plain-text 403,
  // never JSON - parsing those surfaces a raw SyntaxError instead of the cause.
  const contentType = res.headers.get('content-type') ?? '';
  if (res.redirected || res.status === 401 || !contentType.includes('application/json')) {
    window.location.assign('/login');
    throw new Error('Your session expired - redirecting to login…');
  }
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
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
  return `${neg ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

/** Clean a pasted seed: strip list numbering ("1. word") + collapse spaces. */
function cleanSeed(val: string): string {
  return val.replace(/\b\d+[.\s]\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

const card = 'bg-gray-900 border border-gray-800 rounded-xl p-6';
const input = 'w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder:text-gray-600 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600';
const primaryBtn = 'rounded-lg bg-mint-700 hover:bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-50';

const totpInput = `${input} max-w-[8rem] tracking-[0.3em] text-center`;
// ── Component ─────────────────────────────────────────────────────────────────

export default function BitcoinWallet({ explorerUrl, advancedUi = false }: { explorerUrl?: string | null; advancedUi?: boolean }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeIsError, setNoticeIsError] = useState(false);

  const [newMnemonic, setNewMnemonic] = useState<string | null>(null);

  // Create / restore (2FA-gated)
  const [setupTotp, setSetupTotp] = useState('');
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreSeed, setRestoreSeed] = useState('');
  // Destructive-action gate: the submit stays disabled until the user types
  // the confirmation phrase - restoring replaces the current BTC wallet.
  const [restoreConfirm, setRestoreConfirm] = useState('');
  const [setupError, setSetupError] = useState<string | null>(null);

  // Link to the Mintlayer seed (server-side reveal - words never transit the browser)
  const [linkPassword, setLinkPassword] = useState('');
  const [linkTotp, setLinkTotp] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);

  // Send form
  const [sendTo, setSendTo] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sendTotp, setSendTotp] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentTxid, setSentTxid] = useState<string | null>(null);
  const [feeSatVb, setFeeSatVb] = useState<number | null>(null);
  const [addrSuggestion, setAddrSuggestion] = useState<{ corrected: string; fixedChars: number } | null>(null);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const later = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    timers.current.push(t);
  }, []);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const refresh = useCallback(async () => {
    try {
      setLoadError(null);
      setOverview(await api<Overview>('/api/bitcoin/overview'));
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Best-effort fee hint for the send form.
  useEffect(() => {
    api<{ satPerVb: Record<string, number> }>('/api/bitcoin/fee-estimate')
      .then((r) => {
        const fast = r.satPerVb?.['1'] ?? r.satPerVb?.['3'] ?? r.satPerVb?.['6'];
        if (typeof fast === 'number') setFeeSatVb(fast);
      })
      .catch(() => { /* fee hint is optional */ });
  }, []);

  const walletExists = overview?.status?.walletExists ?? false;

  function showNotice(message: string, isError = false) {
    setNotice(message);
    setNoticeIsError(isError);
  }

  // ── Create / restore wallet ─────────────────────────────────────────────────

  async function createWallet(seed?: string) {
    setBusy(true);
    setSetupError(null);
    try {
      const res = await api<{ mnemonic?: string }>('/api/bitcoin/wallet', {
        method: 'POST',
        body: JSON.stringify({ seed: seed ?? null, totp_code: setupTotp.trim() }),
      });
      setRestoreOpen(false);
      setRestoreSeed('');
      setSetupTotp('');
      setRestoreConfirm('');
      // Restores return no mnemonic - only a fresh generate shows the backup step.
      setNewMnemonic(res.mnemonic ?? null);
      await refresh();
    } catch (err) {
      // The code may already be burned by this attempt - never leave stale
      // six digits in the field for the user to blindly resubmit.
      setSetupTotp('');
      setSetupError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Derive the BTC wallet from the Mintlayer wallet's own seed. The
   *  mnemonic is read server-side (wallet-rpc → sidecar) and never sent
   *  to the browser; this call only carries the password + 2FA code. */
  async function linkSeed() {
    setBusy(true);
    setLinkError(null);
    try {
      await api<Record<string, unknown>>('/api/bitcoin/link-seed', {
        method: 'POST',
        body: JSON.stringify({ password: linkPassword, totp_code: linkTotp.trim() }),
      });
      setLinkPassword('');
      setLinkTotp('');
      showNotice('BTC wallet linked to your Mintlayer seed. It is now scanning for funds.');
      await refresh();
    } catch (err) {
      setLinkTotp('');
      setLinkError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submitRestore(e: React.FormEvent) {
    e.preventDefault();
    // Mirror of the disabled-attr gate - requestSubmit() from script bypasses it.
    if (restoreConfirm !== 'I UNDERSTAND') return;
    const seed = cleanSeed(restoreSeed);
    const words = seed.split(/\s+/).filter(Boolean);
    if (words.length !== 12 && words.length !== 24) {
      setSetupError(`A seed phrase has 12 or 24 words - this one has ${words.length}.`);
      return;
    }
    createWallet(seed);
  }

  useEffect(() => {
    if (!restoreOpen || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setRestoreOpen(false);
        setSetupError(null);
        setRestoreConfirm('');
        // Shared with the create flow below - clear so a burned code from the
        // modal never lingers in the inline create form.
        setSetupTotp('');
      }
      // Light focus trap: keep Tab cycling inside the dialog.
      if (e.key === 'Tab') {
        const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, input, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (!nodes || nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector<HTMLElement>('textarea, input, button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [restoreOpen, busy]);

  // ── Sync ────────────────────────────────────────────────────────────────────

  async function triggerSync() {
    setBusy(true);
    try {
      await api('/api/bitcoin/sync', { method: 'POST' });
      showNotice('Sync started - balances refresh in a few seconds.');
      later(refresh, 5000);
    } catch (err) {
      showNotice((err as Error).message, true);
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
    if (!/^\d{6}$/.test(sendTotp.trim())) {
      setSendError('Enter your 6-digit 2FA code to confirm the send.');
      return;
    }

    // Typo recovery: checksum failure with a within-2-chars fix offers a
    // suggestion instead of sending. Never auto-replaces the input.
    const hrp = hrpForNetwork('btc', overview?.status?.network ?? '');
    if (hrp) {
      const res = suggestAddressCorrection(sendTo.trim(), hrp, 'btc');
      if (res.status === 'corrected' && res.corrected) {
        setAddrSuggestion({ corrected: res.corrected, fixedChars: res.fixedChars ?? 1 });
        setSendError('Address checksum failed - review the suggested correction.');
        return;
      }
    }

    if (
      !window.confirm(
        `Send ${sendAmount.trim()} BTC to\n${sendTo.trim()}?\n\nThis cannot be undone.`,
      )
    ) {
      return;
    }

    setBusy(true);
    try {
      const res = await api<{ txid: string }>('/api/bitcoin/send', {
        method: 'POST',
        body: JSON.stringify({
          address: sendTo.trim(),
          amount_btc: sendAmount.trim(),
          totp_code: sendTotp.trim(),
        }),
      });
      setSentTxid(res.txid);
      setSendTo('');
      setSendAmount('');
      setSendTotp('');
      setAddrSuggestion(null);
      later(refresh, 4000);
    } catch (err) {
      setSendError((err as Error).message);
      // The code that failed (invalid, expired or already burnt) must not be
      // retried - clear it so the next attempt starts from a fresh entry.
      setSendTotp('');
    } finally {
      setBusy(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loadError) {
    return (
      <div className={card}>
        <h2 className="text-base font-semibold text-gray-100 mb-2">Couldn&apos;t load the Bitcoin wallet</h2>
        <p className="text-sm text-red-400 mb-3">{loadError}</p>
        <p className="text-sm text-gray-400 mb-4">
          If the Bitcoin stack isn&apos;t running, start it from the host:
        </p>
        <code className="block rounded bg-gray-800 px-3 py-2 text-xs font-mono text-mint-400 mb-4">
          docker compose --profile bitcoin up -d
        </code>
        <button onClick={refresh} className={primaryBtn}>Retry</button>
      </div>
    );
  }
  if (!overview) {
    return (
      <div className={card}>
        <div className="h-4 w-40 rounded bg-gray-800 animate-pulse mb-3" />
        <div className="h-24 rounded bg-gray-800/60 animate-pulse" />
      </div>
    );
  }

  const node = overview.status?.node;
  const offline = !overview.status || !node?.reachable;
  const balance = overview.balance;
  const explorer = explorerUrl ?? null;
  const explorerHost = explorer ? (() => { try { return new URL(explorer).host; } catch { return null; } })() : null;

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
        {node?.reachable && node.pruned && (
          <span
            title={`Pruned node: keeps blocks from #${(node.pruneHeight ?? 0).toLocaleString()} onward. Creating a wallet works normally, but restoring an old seed needs a full node.`}
            className="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400"
          >
            pruned node
          </span>
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
        <div
          role="status"
          className={`rounded-lg border px-4 py-3 text-sm ${
            noticeIsError
              ? 'border-red-800 bg-red-950/50 text-red-300'
              : 'border-mint-700 bg-mint-900/20 text-mint-300'
          }`}
        >
          {notice}
        </div>
      )}

      {/* ── No wallet yet ─────────────────────────────────────────────────────── */}
      {overview.status && !walletExists && !newMnemonic && (
        <div className="space-y-4">
        <div className={card}>
          <h2 className="text-base font-semibold text-gray-100 mb-2">Use my Mintlayer seed</h2>
          <p className="text-sm text-gray-400 mb-4">
            Recommended: derive the BTC wallet from the <span className="text-gray-200 font-medium">same seed phrase as your Mintlayer wallet</span> -
            one seed, both chains (Bitcoin keys derive via BIP84 from the same words).
            Your password and 2FA code are verified on the server; the words themselves never leave it.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void linkSeed();
            }}
            className="space-y-3"
          >
            <div>
              <label htmlFor="btc-link-password" className="block text-xs text-gray-400 mb-1">Mintlayer wallet password</label>
              <input
                id="btc-link-password"
                type="password"
                value={linkPassword}
                onChange={(e) => setLinkPassword(e.target.value)}
                autoComplete="current-password"
                className={`${input} max-w-md`}
              />
            </div>
            <div>
              <label htmlFor="btc-link-totp" className="block text-xs text-gray-400 mb-1">2FA code</label>
              <input
                id="btc-link-totp"
                value={linkTotp}
                onChange={(e) => setLinkTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                className={totpInput}
              />
              <p className="mt-1 text-xs text-gray-500">Moving key material requires a fresh authenticator code.</p>
            </div>
            {linkError && <p className="text-sm text-red-400">{linkError}</p>}
            <button type="submit" disabled={busy || linkTotp.length !== 6 || linkPassword === ''} className={primaryBtn}>
              {busy ? 'Linking…' : 'Link BTC wallet to my Mintlayer seed'}
            </button>
          </form>
          <p className="mt-3 text-xs text-gray-500">
            The BTC wallet scans the full chain so coins received before today are found too.
          </p>
        </div>

        {advancedUi && (
        <div className={card}>
          <h2 className="text-base font-semibold text-gray-100 mb-2">Or restore from a different seed</h2>
          <p className="text-sm text-gray-400 mb-4">
            Use a <span className="text-gray-200 font-medium">different 12 or 24-word seed phrase</span> for the BTC wallet.
            The words are then stored by the BTC sidecar on this machine.
          </p>
          <button onClick={() => { setRestoreOpen(true); setSetupError(null); setRestoreConfirm(''); }} disabled={busy} className={`${primaryBtn} mb-4`}>
            Restore from seed
          </button>
          <div className="rounded-lg border border-yellow-700/50 bg-yellow-900/10 px-3 py-2.5">
            <p className="text-xs text-yellow-400 mb-2">
              Or create an independent BTC wallet - this generates a <span className="font-semibold">separate seed phrase,
              not linked to your Mintlayer wallet</span>. Only pick this if you want the two wallets unrelated.
            </p>
            <button onClick={() => createWallet()} disabled={busy}
              className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 transition-colors disabled:opacity-50">
              Create new wallet
            </button>
          </div>
          {setupError && <p className="mt-2 text-sm text-red-400">{setupError}</p>}
        </div>
        )}
        </div>
      )}

      {/* ── One-time seed display (generated wallet only) ────────────────────── */}
      {newMnemonic && (
        <div className={card}>
          <SeedBackupStep
            mnemonic={newMnemonic}
            walletPath="Bitcoin hot wallet (bdk sidecar on this machine)"
            recoverHint="one-time-only"
          />
          <button onClick={() => { setNewMnemonic(null); refresh(); }} className={`${primaryBtn} mt-4`}>
            Continue
          </button>
        </div>
      )}

      {/* ── Restore modal ────────────────────────────────────────────────────── */}
      {restoreOpen && (
        <div
          ref={dialogRef}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Restore BTC wallet from seed"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) {
              setRestoreOpen(false);
              setSetupError(null);
              setSetupTotp('');
              setRestoreConfirm('');
            }
          }}
        >
          <div className={`${card} w-full max-w-lg max-h-[90vh] overflow-y-auto`}>
            <h2 className="text-base font-semibold text-gray-100 mb-2">Restore from seed phrase</h2>
            <p className="text-sm text-gray-400 mb-3">
              Enter your 12 or 24-word seed phrase. It is stored by the BTC sidecar on this machine.
            </p>
            <form onSubmit={submitRestore} className="space-y-3">
              <div>
                <label htmlFor="btc-restore-seed" className="block text-xs text-gray-400 mb-1">Seed phrase</label>
                <textarea
                  id="btc-restore-seed"
                  value={restoreSeed}
                  onChange={(e) => setRestoreSeed(cleanSeed(e.target.value))}
                  rows={3}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="word1 word2 …"
                  className={`${input} resize-none`}
                />
                <p className="mt-1 text-xs text-gray-500">
                  {restoreSeed.trim() ? restoreSeed.trim().split(/\s+/).length : 0} of 12 or 24 words
                </p>
              </div>
              <div>
                <label htmlFor="btc-restore-totp" className="block text-xs text-gray-400 mb-1">2FA code</label>
                <input
                  id="btc-restore-totp"
                  value={setupTotp}
                  onChange={(e) => setSetupTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className={totpInput}
                />
              </div>
              <div>
                <label htmlFor="btc-restore-confirm" className="block text-xs text-gray-400 mb-1">
                  Type <span className="font-mono font-semibold text-red-400">I UNDERSTAND</span> - restoring replaces the current BTC wallet
                </label>
                <input
                  id="btc-restore-confirm"
                  value={restoreConfirm}
                  onChange={(e) => setRestoreConfirm(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="I UNDERSTAND"
                  className={input}
                />
              </div>
              {setupError && <p className="text-sm text-red-400">{setupError}</p>}
              <div className="flex gap-2 pt-1">
                <button type="submit" disabled={busy || restoreConfirm !== 'I UNDERSTAND'} className={primaryBtn}>
                  {busy ? 'Restoring…' : 'Restore wallet'}
                </button>
                <button
                  type="button"
                  onClick={() => { setRestoreOpen(false); setSetupError(null); setRestoreConfirm(''); }}
                  disabled={busy}
                  className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Wallet ────────────────────────────────────────────────────────────── */}
      {overview.status && walletExists && !newMnemonic && (
        <>
          {/* Balance - the sidecar's "immature" bucket (unmatured coinbase
              rewards) is intentionally not shown: it only applies to mined
              rewards, which wallet users never receive. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className={card}>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Confirmed</p>
              <p className="text-2xl font-semibold text-gray-100">
                {balance ? satsToBtc(balance.confirmed) : '-'} <span className="text-sm font-normal text-gray-500">BTC</span>
              </p>
            </div>
            <div className={card}>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Pending</p>
              <p className="text-2xl font-semibold text-yellow-400">
                {balance ? satsToBtc(BigInt(balance.trustedPending) + BigInt(balance.untrustedPending)) : '-'} <span className="text-sm font-normal text-gray-500">BTC</span>
              </p>
            </div>
          </div>

          {/* Receive + Send */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className={card}>
              <h2 className="text-base font-semibold text-gray-100 mb-4">Receive</h2>
              {overview.address ? (
                <div className="flex flex-col items-center gap-4">
                  {/* White card + default colors: inverted QRs are rejected by
                      some scanners - keep parity with the ML receive modal. */}
                  <div className="rounded-xl bg-white p-3">
                    <QRCodeSVG value={overview.address} size={140} />
                  </div>
                  <code className="block rounded bg-gray-800 px-3 py-2 text-xs font-mono text-mint-400 break-all text-center">
                    {overview.address}
                  </code>
                  <CopyButton value={overview.address} title="Copy address" />
                  {explorer && (
                    <a
                      href={`${explorer}/address/${overview.address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-gray-500 hover:text-mint-400 transition-colors"
                    >
                      View in explorer ↗
                    </a>
                  )}
                </div>
              ) : overview.status?.walletLoaded ? (
                <p className="text-sm text-gray-500">Wallet is loading…</p>
              ) : (
                <div className="text-sm text-yellow-300">
                  Wallet file exists but could not be loaded. Try Sync, and if it persists restart
                  the bitcoin wallet service (docker compose --profile bitcoin up -d).
                </div>
              )}
            </div>

            <div className={card}>
              <h2 className="text-base font-semibold text-gray-100 mb-4">Send</h2>
              {sentTxid && (
                <div role="status" className="mb-4 px-3 py-2 rounded-lg border border-emerald-800 bg-emerald-950/50 text-emerald-300 text-sm">
                  Sent! Transaction <code className="font-mono text-xs break-all">{sentTxid}</code>{' '}
                  <CopyButton value={sentTxid} title="Copy transaction id" />
                  {explorer && (
                    <>
                      {' '}
                      <a href={`${explorer}/tx/${sentTxid}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-emerald-200">
                        View ↗
                      </a>
                    </>
                  )}
                </div>
              )}
              {sendError && (
                <div role="alert" className="mb-4 px-3 py-2 rounded-lg border border-red-800 bg-red-950/50 text-red-300 text-sm">{sendError}</div>
              )}
              <form onSubmit={submitSend} className="space-y-3">
                <div>
                  <label htmlFor="btc-send-to" className="block text-xs text-gray-400 mb-1">To address</label>
                  <input
                    id="btc-send-to"
                    value={sendTo}
                    onChange={e => { setSendTo(e.target.value); setAddrSuggestion(null); }}
                    placeholder="bc1…"
                    className={input}
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </div>
                {addrSuggestion && (
                  <AddressSuggestion
                    corrected={addrSuggestion.corrected}
                    fixedChars={addrSuggestion.fixedChars}
                    onAccept={() => { setSendTo(addrSuggestion.corrected); setAddrSuggestion(null); }}
                    onDismiss={() => setAddrSuggestion(null)}
                  />
                )}
                <div>
                  <label htmlFor="btc-send-amount" className="block text-xs text-gray-400 mb-1">Amount (BTC)</label>
                  <input
                    id="btc-send-amount"
                    value={sendAmount}
                    onChange={e => setSendAmount(e.target.value)}
                    placeholder="0.005"
                    inputMode="decimal"
                    pattern="\d{1,8}(\.\d{1,8})?"
                    className={input}
                    autoComplete="off"
                    required
                  />
                  {feeSatVb !== null && (
                    <p className="mt-1 text-xs text-gray-500">Suggested fee: ~{feeSatVb} sat/vB</p>
                  )}
                </div>
                <div>
                  <label htmlFor="btc-send-totp" className="block text-xs text-gray-400 mb-1">2FA code</label>
                  <input
                    id="btc-send-totp"
                    value={sendTotp}
                    onChange={e => setSendTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="123456"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    className={totpInput}
                    required
                  />
                </div>
                <button type="submit" disabled={busy} className={`${primaryBtn} w-full`}>
                  {busy ? 'Signing…' : 'Review & send'}
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
                        {explorer ? (
                          <a
                            href={`${explorer}/tx/${tx.txid}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-gray-500 font-mono truncate hover:text-mint-400 transition-colors"
                            title={explorerHost ? `View on ${explorerHost}` : 'View in explorer'}
                          >
                            {tx.txid} ↗
                          </a>
                        ) : (
                          <p className="text-xs text-gray-500 font-mono truncate">{tx.txid}</p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`text-xs ${tx.confirmed ? 'text-gray-400' : 'text-yellow-400'}`}>
                          {tx.confirmed ? 'Confirmed' : 'Pending'}
                        </p>
                        {tx.height !== null && <p className="text-xs text-gray-500">#{tx.height.toLocaleString()}</p>}
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
