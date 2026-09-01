import { useState, useEffect } from 'react';
import { submitWithToast } from '@/lib/toastStore';
import { watchTx } from '@/lib/txWatcher';
import { CopyButton } from '@/components/CopyButton';
import { TokenIdTooltip } from '@/components/TokenIdTooltip';
import SafeExternalLink from '@/components/SafeExternalLink';
import { rpc } from '@/lib/client-rpc';
import { toHexField } from '@/lib/token-utils';
import { ModalOverlay } from '@/components/ui/ModalOverlay';

// ── Types ──────────────────────────────────────────────────────────────────────

type FungibleContent = {
  token_id: string;
  token_ticker: { text: string | null; hex: string };
  number_of_decimals: number;
  metadata_uri: { text: string | null; hex: string };
  circulating_supply: { atoms: string };
  total_supply:
    | { type: 'Fixed'; content: { atoms: string } }
    | { type: 'Lockable' }
    | { type: 'Unlimited' };
  is_locked: boolean;
  frozen: { type: 'NotFrozen' } | { type: 'Frozen'; content: { is_unfreezable: boolean } };
  authority: string;
};

interface Props {
  tokenId: string;
  onClose: () => void;
  onRefresh: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function atomsToDecimal(atoms: string, decimals: number): string {
  if (decimals === 0) return atoms;
  const n = BigInt(atoms);
  const factor = 10n ** BigInt(decimals);
  const whole = n / factor;
  const frac = n % factor;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

function supplyLabel(total_supply: FungibleContent['total_supply']): string {
  if (total_supply.type === 'Fixed') return 'Fixed';
  if (total_supply.type === 'Lockable') return 'Lockable';
  return 'Unlimited';
}

// ── Section wrapper ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <div className="bg-gray-800/50 px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
        {title}
      </div>
      <div className="px-4 py-4">{children}</div>
    </div>
  );
}

// ── Action row helpers ─────────────────────────────────────────────────────────

type RunState = 'idle' | 'busy' | 'done' | 'error';

function useAction() {
  const [state, setState] = useState<RunState>('idle');
  const [msg, setMsg] = useState('');

  const run = async (fn: () => Promise<string>) => {
    setState('busy');
    setMsg('');
    try {
      await submitWithToast(fn, watchTx);
      setState('done');
      setMsg('Transaction submitted.');
    } catch (err) {
      setState('error');
      const raw = (err as Error).message;
      setMsg(
        raw.includes('Orphan transaction')
          ? 'A pending transaction is blocking this action. Wait for it to confirm, then try again.'
          : raw
      );
    }
  };

  return { state, msg, run };
}

// ── Mint section ───────────────────────────────────────────────────────────────

function MintSection({ tokenId, onRefresh }: { tokenId: string; onRefresh: () => void }) {
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const { state, msg, run } = useAction();

  useEffect(() => {
    rpc<{ address: string; used: boolean }[]>('address_show', { account: 0, include_change_addresses: false })
      .then(addrs => {
        const first = addrs.find(a => !a.used) ?? addrs[addrs.length - 1];
        if (first) setAddress(first.address);
      })
      .catch(() => {});
  }, []);

  return (
    <Section title="Mint new tokens">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Amount</label>
            <input
              type="number" min="0" step="any" value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Recipient address</label>
            <input
              type="text" value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder="mtc1…"
              className={inputCls}
            />
          </div>
        </div>
        {msg && <p className={state === 'error' ? errorCls : successCls}>{msg}</p>}
        <button
          disabled={state === 'busy' || !amount || !address}
          onClick={() => run(async () => {
            const res = await rpc<{ tx_id: string }>('token_mint', { account: 0, token_id: tokenId, address, amount: { decimal: amount }, options: {} });
            onRefresh();
            return res.tx_id;
          })}
          className={actionBtn}
        >
          {state === 'busy' ? 'Minting…' : 'Mint'}
        </button>
      </div>
    </Section>
  );
}

// ── Unmint section ─────────────────────────────────────────────────────────────

function UnmintSection({ tokenId, onRefresh }: { tokenId: string; onRefresh: () => void }) {
  const [amount, setAmount] = useState('');
  const { state, msg, run } = useAction();

  return (
    <Section title="Unmint tokens">
      <p className="text-xs text-gray-500 mb-3">Burns tokens you hold, reducing circulating supply.</p>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Amount to unmint</label>
          <input
            type="number" min="0" step="any" value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0.00"
            className={inputCls}
          />
        </div>
        {msg && <p className={state === 'error' ? errorCls : successCls}>{msg}</p>}
        <button
          disabled={state === 'busy' || !amount}
          onClick={() => run(async () => {
            const res = await rpc<{ tx_id: string }>('token_unmint', { account: 0, token_id: tokenId, amount: { decimal: amount }, options: {} });
            onRefresh();
            return res.tx_id;
          })}
          className={actionBtn}
        >
          {state === 'busy' ? 'Unminting…' : 'Unmint'}
        </button>
      </div>
    </Section>
  );
}

// ── Lock supply section ────────────────────────────────────────────────────────

function LockSupplySection({ tokenId, onRefresh }: { tokenId: string; onRefresh: () => void }) {
  const [confirm, setConfirm] = useState('');
  const { state, msg, run } = useAction();
  const CONFIRM_PHRASE = 'LOCK';

  return (
    <Section title="Lock supply">
      <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 mb-4">
        <p className="text-sm font-semibold text-red-400 mb-1">Irreversible action</p>
        <p className="text-xs text-red-300">
          Once locked, the supply is permanently fixed. No more tokens can ever be minted or unminted.
        </p>
      </div>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">
            Type <span className="font-mono text-gray-300">LOCK</span> to confirm
          </label>
          <input
            type="text" value={confirm}
            onChange={e => setConfirm(e.target.value.toUpperCase())}
            placeholder="LOCK"
            className={inputCls}
          />
        </div>
        {msg && <p className={state === 'error' ? errorCls : successCls}>{msg}</p>}
        <button
          disabled={state === 'busy' || confirm !== CONFIRM_PHRASE}
          onClick={() => run(async () => {
            const res = await rpc<{ tx_id: string }>('token_lock_supply', { account_index: 0, token_id: tokenId, options: {} });
            onRefresh();
            return res.tx_id;
          })}
          className="w-full rounded-lg bg-red-800 hover:bg-red-700 disabled:opacity-40 px-4 py-2 text-sm font-semibold text-white transition-colors"
        >
          {state === 'busy' ? 'Locking…' : 'Lock Supply Permanently'}
        </button>
      </div>
    </Section>
  );
}

// ── Freeze section ─────────────────────────────────────────────────────────────

function FreezeSection({ tokenId, onRefresh }: { tokenId: string; onRefresh: () => void }) {
  const [isUnfreezable, setIsUnfreezable] = useState(true);
  const { state, msg, run } = useAction();

  return (
    <Section title="Freeze token">
      <p className="text-xs text-gray-500 mb-3">Freezing forbids all transfers and operations on this token.</p>
      <div className="space-y-3">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox" checked={isUnfreezable}
            onChange={e => setIsUnfreezable(e.target.checked)}
            className="rounded accent-mint-500"
          />
          <span className="text-sm text-gray-300">Allow unfreezing later</span>
        </label>
        <p className="text-xs text-gray-500">
          {isUnfreezable
            ? 'You will be able to unfreeze this token in the future.'
            : 'This freeze will be permanent - the token can never be unfrozen.'}
        </p>
        {msg && <p className={state === 'error' ? errorCls : successCls}>{msg}</p>}
        <button
          disabled={state === 'busy'}
          onClick={() => run(async () => {
            const res = await rpc<{ tx_id: string }>('token_freeze', { account: 0, token_id: tokenId, is_unfreezable: isUnfreezable, options: {} });
            onRefresh();
            return res.tx_id;
          })}
          className={actionBtn}
        >
          {state === 'busy' ? 'Freezing…' : 'Freeze Token'}
        </button>
      </div>
    </Section>
  );
}

// ── Unfreeze section ───────────────────────────────────────────────────────────

function UnfreezeSection({ tokenId, onRefresh }: { tokenId: string; onRefresh: () => void }) {
  const { state, msg, run } = useAction();

  return (
    <Section title="Unfreeze token">
      <p className="text-xs text-gray-500 mb-3">Restores all operations on this token.</p>
      {msg && <p className={`mb-3 ${state === 'error' ? errorCls : successCls}`}>{msg}</p>}
      <button
        disabled={state === 'busy'}
        onClick={() => run(async () => {
          const res = await rpc<{ tx_id: string }>('token_unfreeze', { account: 0, token_id: tokenId, options: {} });
          onRefresh();
          return res.tx_id;
        })}
        className={actionBtn}
      >
        {state === 'busy' ? 'Unfreezing…' : 'Unfreeze Token'}
      </button>
    </Section>
  );
}

// ── Change authority section ───────────────────────────────────────────────────

function ChangeAuthoritySection({ tokenId, currentAuthority, onRefresh }: { tokenId: string; currentAuthority: string; onRefresh: () => void }) {
  const [address, setAddress] = useState('');
  const { state, msg, run } = useAction();

  return (
    <Section title="Change authority">
      <p className="text-xs text-gray-500 mb-3">
        Current: <span className="font-mono text-gray-300 break-all">{currentAuthority}</span>
      </p>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">New authority address</label>
          <input
            type="text" value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="mtc1…"
            className={inputCls}
          />
        </div>
        {msg && <p className={state === 'error' ? errorCls : successCls}>{msg}</p>}
        <button
          disabled={state === 'busy' || !address}
          onClick={() => run(async () => {
            const res = await rpc<{ tx_id: string }>('token_change_authority', { account: 0, token_id: tokenId, address, options: {} });
            onRefresh();
            return res.tx_id;
          })}
          className={actionBtn}
        >
          {state === 'busy' ? 'Changing…' : 'Change Authority'}
        </button>
      </div>
    </Section>
  );
}

// ── Change metadata URI section ────────────────────────────────────────────────

function ChangeMetadataUriSection({ tokenId, currentUri, onRefresh }: { tokenId: string; currentUri: string | null; onRefresh: () => void }) {
  const [uri, setUri] = useState('');
  const { state, msg, run } = useAction();

  return (
    <Section title="Update metadata URI">
      {currentUri && (
        <p className="text-xs text-gray-500 mb-3">
          Current: <SafeExternalLink uri={currentUri} className="text-mint-400 hover:text-mint-300 break-all" />
        </p>
      )}
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">New metadata URI</label>
          <input
            type="text" value={uri}
            onChange={e => setUri(e.target.value)}
            placeholder="ipfs://… or https://…"
            className={inputCls}
          />
        </div>
        {msg && <p className={state === 'error' ? errorCls : successCls}>{msg}</p>}
        <button
          disabled={state === 'busy' || !uri}
          onClick={() => run(async () => {
            const res = await rpc<{ tx_id: string }>('token_change_metadata_uri', { account: 0, token_id: tokenId, metadata_uri: toHexField(uri), options: {} });
            onRefresh();
            return res.tx_id;
          })}
          className={actionBtn}
        >
          {state === 'busy' ? 'Updating…' : 'Update URI'}
        </button>
      </div>
    </Section>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function TokenManagePanel({ tokenId, onClose, onRefresh }: Props) {
  const [info, setInfo] = useState<FungibleContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  async function fetchInfo() {
    try {
      setLoadError(null);
      const results = await rpc<Array<{ type: string; content: FungibleContent } | null>>(
        'node_get_tokens_info', { token_ids: [tokenId] }
      );
      const item = results[0];
      if (!item || item.type !== 'FungibleToken') {
        setLoadError('Not a fungible token or not found.');
        return;
      }
      setInfo(item.content);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  useEffect(() => { fetchInfo(); }, [tokenId]);

  const handleRefresh = () => { fetchInfo(); onRefresh(); };

  const ticker = info?.token_ticker.text ?? tokenId.slice(0, 12) + '…';
  const isFrozen = info?.frozen.type === 'Frozen';
  const isUnfreezable = info?.frozen.type === 'Frozen' && (info.frozen as { type: 'Frozen'; content: { is_unfreezable: boolean } }).content.is_unfreezable;
  const canMint = info && !info.is_locked && !isFrozen && info.total_supply.type !== 'Fixed';
  const canUnmint = info && !info.is_locked && !isFrozen && info.total_supply.type === 'Lockable';
  const canLock = info && !info.is_locked && !isFrozen && info.total_supply.type === 'Lockable';
  const canFreeze = info && !isFrozen;
  const decimals = info?.number_of_decimals ?? 0;

  return (
    <ModalOverlay onClose={onClose} maxWidth="max-w-xl" maxHeight="max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
          <div>
            <h2 className="inline-flex items-center gap-1.5 text-base font-semibold text-gray-100">
              Manage {ticker}
              <TokenIdTooltip tokenId={tokenId} />
            </h2>
            <span className="inline-flex items-center gap-1 mt-0.5">
              <code className="text-xs font-mono text-gray-500">{tokenId.slice(0, 20)}…</code>
              <CopyButton value={tokenId} title="Copy token ID" />
            </span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
          {loadError && (
            <div className="rounded-lg border border-red-700 bg-red-900/30 p-3 text-red-300 text-sm">{loadError}</div>
          )}

          {!info && !loadError && (
            <p className="text-sm text-gray-500">Loading token info…</p>
          )}

          {info && (
            <>
              {/* Token info summary */}
              <div className="rounded-lg bg-gray-800/50 border border-gray-800 px-4 py-3 text-sm space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-gray-500">Supply type</span>
                  <span className="text-gray-200">{supplyLabel(info.total_supply)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Circulating supply</span>
                  <span className="inline-flex items-center gap-1 font-mono text-gray-200">
                    {atomsToDecimal(info.circulating_supply.atoms, decimals)} {ticker}
                    <TokenIdTooltip tokenId={tokenId} align="right" />
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Supply locked</span>
                  <span className={info.is_locked ? 'text-amber-400' : 'text-gray-400'}>{info.is_locked ? 'Yes' : 'No'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Frozen</span>
                  <span className={isFrozen ? 'text-blue-400' : 'text-gray-400'}>{isFrozen ? 'Yes' : 'No'}</span>
                </div>
                {info.metadata_uri.text && (
                  <div className="flex justify-between gap-4">
                    <span className="text-gray-500 shrink-0">Metadata URI</span>
                    <SafeExternalLink uri={info.metadata_uri.text}
                       className="text-mint-400 hover:text-mint-300 text-xs font-mono break-all text-right" />
                  </div>
                )}
              </div>

              {isFrozen && !isUnfreezable && (
                <div className="rounded-lg border border-blue-800 bg-blue-900/20 px-4 py-3 text-blue-300 text-sm">
                  This token is permanently frozen. No operations are possible.
                </div>
              )}

              {canMint       && <MintSection tokenId={tokenId} onRefresh={handleRefresh} />}
              {canUnmint     && <UnmintSection tokenId={tokenId} onRefresh={handleRefresh} />}
              {canLock       && <LockSupplySection tokenId={tokenId} onRefresh={handleRefresh} />}
              {isUnfreezable && <UnfreezeSection tokenId={tokenId} onRefresh={handleRefresh} />}

              {/* Advanced / risky operations */}
              {(!isFrozen || isUnfreezable) && (
                <div className="border border-orange-900/50 rounded-lg overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(v => !v)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-orange-950/30 hover:bg-orange-950/50 transition-colors text-left"
                  >
                    <span className="text-xs font-semibold text-orange-400 uppercase tracking-wider">
                      Advanced &amp; risky operations
                    </span>
                    <svg
                      width="14" height="14" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2.5"
                      className={`text-orange-500 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>

                  {showAdvanced && (
                    <div className="px-4 py-4 space-y-4 bg-orange-950/10">
                      <p className="text-xs text-orange-300/70">
                        These actions affect token governance and are difficult or impossible to reverse.
                      </p>
                      {canFreeze && <FreezeSection tokenId={tokenId} onRefresh={handleRefresh} />}
                      <ChangeAuthoritySection tokenId={tokenId} currentAuthority={info.authority} onRefresh={handleRefresh} />
                      <ChangeMetadataUriSection tokenId={tokenId} currentUri={info.metadata_uri.text ?? null} onRefresh={handleRefresh} />
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-800 shrink-0 flex justify-end">
          <button onClick={onClose} className="rounded-lg border border-gray-700 px-5 py-2 text-sm text-gray-300 hover:bg-gray-800 transition-colors">
            Close
          </button>
        </div>
    </ModalOverlay>
  );
}

// ── Style constants ────────────────────────────────────────────────────────────

const inputCls = 'w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600';
const actionBtn = 'w-full rounded-lg bg-mint-700 hover:bg-mint-600 disabled:opacity-40 px-4 py-2 text-sm font-semibold text-white transition-colors';
const errorCls = 'text-xs text-red-400';
const successCls = 'text-xs text-green-400';
