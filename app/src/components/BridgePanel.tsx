"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createBridgeSdk,
  type BridgeConfig,
  type BridgeFees,
  type BridgeRequestDetail,
} from '@/lib/bridge-sdk';
import {
  connectMetaMask,
  depositToBridge,
  getConnectedAccount,
  getTokenBalance,
  hasEthereumProvider,
  normalizeEvmRejection,
  switchChain,
} from '@/lib/evm';
import { suggestAddressCorrection, hrpForNetwork } from '@/lib/bech32-correct';
import { rpc } from '@/lib/client-rpc';
import { isPositiveDecimal } from '@/lib/validation';
import { validateEvmAddress } from '@/lib/bridge-sdk/addresses';
import AddressSuggestion from '@/components/AddressSuggestion';

const sdk = createBridgeSdk();

type Direction = 'e2m' | 'm2e';
type Phase =
  | 'idle'
  | 'approve'
  | 'deposit'
  | 'signing'
  | 'submitting'
  | 'polling'
  | 'done'
  | 'failed'
  | 'manual';

interface Asset {
  ticker: string;
  mlTokenId: string;
  ethAddress?: string;
  maxAmountPerRequest?: string;
}

const card = 'bg-gray-900 border border-gray-800 rounded-xl p-6';
const input =
  'w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600';
const primaryBtn =
  'w-full rounded-lg bg-mint-700 hover:bg-mint-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const totpInput = `${input} max-w-[8rem] tracking-[0.3em] text-center`;

/** Fixed-point decimal total: fixed + amount × pct/100, at 18-digit scale. */
function totalFee(fixed: string, amount: string, pctPercent: string): string | null {
  try {
    const toScaled = (s: string): bigint | null => {
      const t = s.trim().replace(/%\s*$/, '');
      if (!/^\d+(\.\d+)?$/.test(t)) return null;
      const [i, f = ''] = t.split('.');
      return BigInt(i + (f + '0'.repeat(18)).slice(0, 18));
    };
    const S = 10n ** 18n;
    const f = toScaled(fixed);
    const a = toScaled(amount);
    const p = toScaled(pctPercent);
    if (f === null || a === null || p === null) return null;
    const total = f + (a * p) / (100n * S); // pct is a percentage: /100 overall
    // format at scale 18, trim trailing zeros
    const whole = total / S;
    const frac = (total % S).toString().padStart(18, '0').replace(/0+$/, '');
    return `${whole.toString()}${frac ? `.${frac}` : ''}`;
  } catch {
    return null;
  }
}

/** Sepolia is the only non-mainnet flavor the bridge agents deploy to. */
function chainForFlavor(flavor: string): { id: string; params: Record<string, unknown> } | null {
  if (flavor === 'sepolia') {
    return {
      id: '0xaa36a7',
      params: {
        chainName: 'Sepolia Testnet',
        nativeCurrency: { name: 'Sepolia ETH', symbol: 'SEP', decimals: 18 },
        rpcUrls: ['https://sepolia.infura.io/v3/'],
        blockExplorerUrls: ['https://sepolia.etherscan.io'],
      },
    };
  }
  return { id: '0x1', params: {} };
}

const STATUS_STEPS: Record<string, { label: string; step: number }> = {
  pending: { label: 'Agents processing deposit…', step: 1 },
  processed_by_master: { label: 'Signed by master agent — waiting for cosigner…', step: 2 },
  completed: { label: 'Bridge completed', step: 3 },
};

interface IndexerStatus {
  up: boolean;
  nodeUp: boolean;
  height: number | null;
  nodeHeight: number | null;
  synced: boolean;
}

export default function BridgePanel({ indexerEnabled = false }: { indexerEnabled?: boolean }) {
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [fees, setFees] = useState<BridgeFees | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const [direction, setDirection] = useState<Direction>('e2m');
  const [assetTicker, setAssetTicker] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [receiver, setReceiver] = useState('');
  const [receiverSuggestion, setReceiverSuggestion] = useState<{ corrected: string; fixedChars: number } | null>(null);
  const [bridgeTotp, setBridgeTotp] = useState('');
  const bridgeTotpRef = useRef<HTMLInputElement>(null);

  const [ethAccount, setEthAccount] = useState<string | null>(null);
  const [ethBalance, setEthBalance] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [mlAddress, setMlAddress] = useState<string | null>(null);
  const [addressLoading, setAddressLoading] = useState(false);
  const [indexerStatus, setIndexerStatus] = useState<IndexerStatus | null>(null);
  const [indexerError, setIndexerError] = useState(false);

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [requestUuid, setRequestUuid] = useState<string | null>(null);
  const [requestStatus, setRequestStatus] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Synchronous double-submit guard: between the confirm dialog and the first
  // setPhase the async submits leave `busy` false, so the button alone can't
  // stop a double click from creating two deposits.
  const submittingRef = useRef(false);

  const metamaskInstalled = hasEthereumProvider();

  // ── Bridge config + fees ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfg, feeTable] = await Promise.all([sdk.getConfig(), sdk.getFees()]);
        if (cancelled) return;
        setConfig(cfg);
        setFees(feeTable);
        const tickers = Object.keys(cfg.ml_tokens ?? {});
        setAssetTicker((prev) => prev || tickers[0] || '');
      } catch (err) {
        if (!cancelled) setConfigError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Own ML address (receive side for E2M) ───────────────────────────────────
  const fetchMlAddress = useCallback(async (): Promise<string | null> => {
    try {
      const result = await rpc<{ address: string; used: boolean; purpose: string }[]>(
        'address_show',
        { account: 0, include_change_addresses: false },
      );
      if (!Array.isArray(result)) return null;
      const first = result.find((a) => a.purpose === 'Receive' && !a.used) ?? result[0];
      return first?.address ?? null;
    } catch {
      return null; /* dashboard shows wallet errors elsewhere */
    }
  }, []);

  const loadMlAddress = useCallback(async () => {
    const address = await fetchMlAddress();
    if (address) setMlAddress(address);
  }, [fetchMlAddress]);
  useEffect(() => {
    loadMlAddress();
  }, [loadMlAddress]);

  /** Fill the receiver with a fresh receive address from the ML wallet. */
  async function useMlAddress() {
    setAddressLoading(true);
    try {
      const address = await fetchMlAddress();
      if (address) {
        setMlAddress(address);
        setReceiver(address);
        setReceiverSuggestion(null);
      }
    } finally {
      setAddressLoading(false);
    }
  }

  // ── Indexer readiness gate ──────────────────────────────────────────────────
  const loadIndexerStatus = useCallback(() => {
    if (!indexerEnabled) return;
    fetch('/api/indexer-status')
      .then((r) => {
        if (!r.ok) throw new Error(`indexer-status ${r.status}`);
        return r.json() as Promise<IndexerStatus>;
      })
      .then((s) => {
        setIndexerStatus(s);
        setIndexerError(false);
      })
      .catch(() => setIndexerError(true));
  }, [indexerEnabled]);

  useEffect(() => {
    loadIndexerStatus();
    const t = setInterval(loadIndexerStatus, 10_000);
    return () => clearInterval(t);
  }, [loadIndexerStatus]);

  const indexerReady = !indexerEnabled || indexerStatus?.synced === true;

  // ── MetaMask session restore ────────────────────────────────────────────────
  useEffect(() => {
    getConnectedAccount().then(setEthAccount);
  }, []);

  const assets: Asset[] = useMemo(() => {
    if (!config) return [];
    const network = config.network_type === 'mainnet' ? 'mainnet' : 'sepolia';
    const flavors = config.eth_flavor_specific_config ?? {};
    const flavorCfg = flavors[network] ?? flavors[''] ?? null;
    const tokenConfig = flavorCfg?.token_config ?? {};
    return Object.keys(config.ml_tokens ?? {}).map((ticker) => ({
      ticker,
      mlTokenId: config.ml_tokens[ticker],
      ethAddress: tokenConfig[ticker]?.address,
      maxAmountPerRequest: tokenConfig[ticker]?.max_amount_per_request,
    }));
  }, [config]);

  const networkType = config?.network_type ?? 'mainnet';
  const flavor = networkType === 'mainnet' ? '' : 'sepolia';
  const sourceChain = direction === 'e2m' ? `Ethereum${flavor ? `-${flavor}` : ''}` : 'Mintlayer';
  const destinationChain = direction === 'e2m' ? 'Mintlayer' : `Ethereum${flavor ? `-${flavor}` : ''}`;
  const asset = assets.find((a) => a.ticker === assetTicker) ?? null;
  const assetFees = fees?.[assetTicker];
  const directionFees = direction === 'e2m' ? assetFees?.to_ml : assetFees?.to_eth;

  async function connectWallet() {
    setConnecting(true);
    setError(null);
    setInfo(null);
    try {
      await switchChainIfNeeded();
      const address = await connectMetaMask();
      setEthAccount(address);
      // Show the bridged-token balance for the selected asset
      if (asset?.ethAddress) {
        setEthBalance(await getTokenBalance(asset.ethAddress, address).catch(() => null));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  async function switchChainIfNeeded() {
    const chain = chainForFlavor(flavor);
    if (!chain) return;
    await switchChain(chain.id, chain.params);
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function pollRequest(uuid: string) {
    stopPolling();
    setPhase('polling');
    pollRef.current = setInterval(async () => {
      try {
        const detail: BridgeRequestDetail = await sdk.getBridgeRequest(uuid);
        const status = String(detail.status ?? 'pending');
        setRequestStatus(status);
        if (status === 'completed' || status === 'failed' || status === 'manual') {
          stopPolling();
          setPhase(status === 'completed' ? 'done' : status === 'manual' ? 'manual' : 'failed');
        }
      } catch {
        /* transient poll errors are retried on the next tick */
      }
    }, 10_000);
  }

  useEffect(() => stopPolling, []);

  function resetForm() {
    setPhase('idle');
    setRequestUuid(null);
    setRequestStatus(null);
    setAmount('');
    setReceiver('');
    setReceiverSuggestion(null);
    setBridgeTotp('');
  }

  async function submit() {
    setError(null);
    setInfo(null);
    setReceiverSuggestion(null);
    if (!asset) {
      setError('No bridged asset selected.');
      return;
    }
    if (!amount.trim() || !receiver.trim()) {
      setError(direction === 'e2m' ? 'Amount and Mintlayer address are required.' : 'Amount and Ethereum address are required.');
      return;
    }
    if (!isPositiveDecimal(amount)) {
      setError('Amount must be a positive decimal number.');
      return;
    }
    if (
      asset.maxAmountPerRequest &&
      /^\d+(\.\d+)?$/.test(asset.maxAmountPerRequest) &&
      parseFloat(amount.trim()) > parseFloat(asset.maxAmountPerRequest)
    ) {
      setError(`Maximum ${asset.maxAmountPerRequest} ${assetTicker} per bridge request.`);
      return;
    }
    if (direction === 'm2e') {
      const evmCheck = validateEvmAddress(receiver);
      if (!evmCheck.valid) {
        setError(evmCheck.error ?? 'Receiver must be a valid 0x… Ethereum address.');
        return;
      }
    }
    if (direction === 'm2e' && !/^\d{6}$/.test(bridgeTotp.trim())) {
      setError('Enter your 6-digit 2FA code to sign the bridge transaction.');
      return;
    }

    // E2M: the ML receiver can be typo-corrected via the bech32 checksum.
    if (direction === 'e2m') {
      const hrp = hrpForNetwork('ml', networkType);
      if (!hrp) {
        // Fail closed: an unvalidatable address must never reach the bridge.
        setError(`Cannot validate Mintlayer addresses for network "${networkType}".`);
        return;
      }
      {
        const res = suggestAddressCorrection(receiver.trim(), hrp, 'ml');
        if (res.status === 'corrected' && res.corrected) {
          setReceiverSuggestion({ corrected: res.corrected, fixedChars: res.fixedChars ?? 1 });
          setError('Address checksum failed — review the suggested correction.');
          return;
        }
        if (res.status === 'invalid') {
          setError('Invalid Mintlayer address.');
          return;
        }
      }
    }

    // Review step: bridge transfers are irreversible — one explicit
    // confirmation with the full amount/fee/destination summary.
    const feeSummary = directionFees
      ? (() => {
          const total = totalFee(directionFees.fixed_fee, amount.trim(), directionFees.percentage_fee ?? '');
          return total !== null ? `\nFee: ${total} ${assetTicker}` : '';
        })()
      : '';
    if (
      !window.confirm(
        `Bridge ${amount.trim()} ${assetTicker}\n${sourceChain} → ${destinationChain}\nReceiver: ${receiver.trim()}${feeSummary}\n\nThis cannot be undone. Continue?`,
      )
    ) {
      return;
    }

    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      if (direction === 'e2m') {
        // ── Ethereum → Mintlayer ──
        if (!ethAccount) throw new Error('Connect MetaMask first.');
        if (!asset.ethAddress) throw new Error('No Ethereum token configured for this asset.');
        await switchChainIfNeeded();
        const txHash = await depositToBridge(
          config?.eth_flavor_specific_config?.[flavor]?.bridge_contract_address ??
            config?.eth_flavor_specific_config?.['']?.bridge_contract_address ??
            '',
          asset.ethAddress,
          amount.trim(),
          18,
          receiver.trim(),
          setPhase,
        );
        setPhase('submitting');
        const res = await sdk.broadcastBridgeRequest({
          source_chain: sourceChain,
          destination_chain: destinationChain,
          asset: asset.ticker,
          amount: amount.trim(),
          receiver_address: receiver.trim(),
          deposit_transactions: [{ transaction_hash: txHash }],
        });
        setRequestUuid(res.bridge_request_uuid);
        pollRequest(res.bridge_request_uuid);
      } else {
        // ── Mintlayer → Ethereum ──
        if (!ethAccount) throw new Error('Connect MetaMask first (it is the receiver).');
        setPhase('signing');
        const signedRes = await fetch('/api/bridge/ml-intent-tx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token_id: asset.mlTokenId,
            amount: amount.trim(),
            intent: receiver.trim(),
            totp_code: bridgeTotp.trim(),
          }),
        });
        // Session expiry: the auth middleware answers with a 302 to /login,
        // which fetch silently follows — the body is HTML, not JSON.
        if (signedRes.redirected) {
          setBridgeTotp('');
          setPhase('idle');
          setError('Your session expired — redirecting to login…');
          setTimeout(() => location.assign('/login'), 800);
          return;
        }
        if (!(signedRes.headers.get('content-type') ?? '').includes('application/json')) {
          // Proxy interstitial / gateway error page — parse nothing.
          bridgeTotpRef.current?.focus();
          throw new Error(`Bridge signing failed (HTTP ${signedRes.status}) — no transaction was created.`);
        }
        const signed = await signedRes.json() as { ok: boolean; error?: string; raw_transaction?: string; intent?: string; code_consumed?: boolean };
        if (!signed.ok || !signed.raw_transaction || !signed.intent) {
          // Failures after the step-up gate consumed the authenticator code:
          // clear the field so the retry starts with a fresh code.
          const consumedHint = signed.code_consumed
            ? ' Your authenticator code was consumed — enter a fresh code to retry.'
            : '';
          if (signed.code_consumed) {
            setBridgeTotp('');
            bridgeTotpRef.current?.focus();
          }
          throw new Error((signed.error ?? 'Failed to create the bridge transaction.') + consumedHint);
        }
        setPhase('submitting');
        const res = await sdk.broadcastBridgeRequest({
          source_chain: sourceChain,
          destination_chain: destinationChain,
          asset: asset.ticker,
          amount: amount.trim(),
          receiver_address: receiver.trim(),
          deposit_transactions: [
            { raw_transaction: signed.raw_transaction, intent: signed.intent },
          ],
        });
        setRequestUuid(res.bridge_request_uuid);
        pollRequest(res.bridge_request_uuid);
      }
    } catch (err) {
      // Wallet rejections are user choices, not failures — an EvmError with
      // code 4001 renders as neutral info, everything else as a real error.
      const e = normalizeEvmRejection(err);
      if (e.code === 4001) {
        setInfo(e.message);
        setPhase('idle');
      } else {
        setError(e.message);
        setPhase('idle');
      }
    } finally {
      submittingRef.current = false;
    }
  }

  const busy = phase === 'approve' || phase === 'deposit' || phase === 'signing' || phase === 'submitting' || phase === 'polling';
  const receiverLabel = direction === 'e2m' ? 'Your Mintlayer address (receiver)' : 'Your Ethereum address (receiver)';

  // ── Gating cards ──────────────────────────────────────────────────────────────
  if (indexerEnabled && indexerError) {
    return (
      <div className={card}>
        <div className="flex items-center gap-3 mb-3">
          <span className="w-2 h-2 rounded-full bg-red-500 shrink-0"></span>
          <h2 className="text-base font-semibold text-gray-100">Couldn&apos;t check the indexer status</h2>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          The bridge stays disabled while the indexer status is unknown, so you don&apos;t act on
          incomplete balances or history.
        </p>
        <button onClick={loadIndexerStatus} className={primaryBtn + ' w-auto px-4'}>Retry</button>
      </div>
    );
  }

  if (indexerEnabled && indexerStatus && !indexerStatus.nodeUp) {
    return (
      <div className={card}>
        <div className="flex items-center gap-3 mb-3">
          <span className="w-2 h-2 rounded-full bg-red-500 shrink-0"></span>
          <h2 className="text-base font-semibold text-gray-100">The Mintlayer node is unreachable</h2>
        </div>
        <p className="text-sm text-gray-400 mb-3">
          The bridge needs the node to verify balances and history. Check that the node daemon is
          running:
        </p>
        <code className="block rounded bg-gray-800 px-3 py-2 text-xs font-mono text-mint-400 mb-4">
          docker compose ps node-daemon
        </code>
        <button onClick={loadIndexerStatus} className={primaryBtn + ' w-auto px-4'}>Retry</button>
      </div>
    );
  }

  if (indexerEnabled && indexerStatus && !indexerStatus.up) {
    // Distinguish "indexer down" from "still syncing" — both leave synced
    // false, but a down indexer would otherwise render as syncing block #0
    // (0%) forever with no hint that anything is actually wrong.
    return (
      <div className={card}>
        <div className="flex items-center gap-3 mb-3">
          <span className="w-2 h-2 rounded-full bg-red-500 shrink-0"></span>
          <h2 className="text-base font-semibold text-gray-100">The indexer is offline</h2>
        </div>
        <p className="text-sm text-gray-400 mb-3">
          The bridge needs the indexer to read balances and history. Start it with:
        </p>
        <code className="block rounded bg-gray-800 px-3 py-2 text-xs font-mono text-mint-400 mb-4">
          docker compose --profile indexer up -d
        </code>
        <button onClick={loadIndexerStatus} className={primaryBtn + ' w-auto px-4'}>Retry</button>
      </div>
    );
  }

  if (indexerEnabled && indexerStatus && !indexerStatus.synced) {
    const height = indexerStatus.height ?? 0;
    const nodeHeight = indexerStatus.nodeHeight ?? 0;
    const pct = nodeHeight > 0 ? Math.min(100, Math.round((height / nodeHeight) * 100)) : 0;
    return (
      <div className={card}>
        <div className="flex items-center gap-3 mb-3">
          <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse shrink-0"></span>
          <h2 className="text-base font-semibold text-gray-100">The indexer is still syncing</h2>
        </div>
        <p className="text-sm text-gray-400 mb-3">
          The bridge stays disabled until the indexer has caught up with the node, so
          you don't act on incomplete balances or history.
        </p>
        <div className="w-full h-2 rounded-full bg-gray-800 overflow-hidden mb-2">
          <div className="h-full bg-mint-600 transition-all" style={{ width: `${pct}%` }}></div>
        </div>
        <p className="text-xs text-gray-500 font-mono">
          indexer block #{height.toLocaleString()} / node block #{nodeHeight.toLocaleString()} ({pct}%)
        </p>
        <p className="text-xs text-gray-500 mt-2">This page re-checks automatically every 10 seconds.</p>
      </div>
    );
  }

  const phaseState =
    phase === 'done' ? 'ok' : phase === 'failed' || phase === 'manual' ? 'bad' : 'busy';
  const phaseLabel =
    phase === 'approve'
      ? 'Waiting for ERC20 approval in MetaMask…'
      : phase === 'deposit'
        ? 'Waiting for deposit confirmation in MetaMask…'
        : phase === 'signing'
          ? 'Signing the bridge transaction with your ML wallet…'
          : phase === 'submitting'
            ? 'Submitting the bridge request…'
            : phase === 'polling'
              ? (requestStatus ? (STATUS_STEPS[requestStatus]?.label ?? `Status: ${requestStatus}`) : 'Agents are processing…')
              : phase === 'done'
                ? 'Bridge completed — tokens arrived.'
                : phase === 'failed'
                  ? 'Bridge failed.'
                  : phase === 'manual'
                    ? 'Escalated for manual review — support will look at this request.'
                    : '';
  const phaseStep = requestStatus ? (STATUS_STEPS[requestStatus]?.step ?? 1) : 1;

  return (
    <div className="space-y-6">
      {configError && (
        <div className="rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-300">
          Bridge service unreachable: {configError}
        </div>
      )}

      {/* ── Direction toggle ── */}
      <div className="grid grid-cols-2 gap-3">
        {(
          [
            { key: 'e2m', label: 'Ethereum → Mintlayer', sub: 'Deposit ERC20, receive ML tokens' },
            { key: 'm2e', label: 'Mintlayer → Ethereum', sub: 'Bridge ML tokens back to ERC20' },
          ] as const
        ).map(({ key, label, sub }) => (
          <button
            key={key}
            type="button"
            onClick={() => { setDirection(key); setError(null); setInfo(null); }}
            className={`rounded-xl border px-4 py-3 text-left transition-colors ${
              direction === key
                ? 'border-mint-600 bg-mint-900/20'
                : 'border-gray-800 bg-gray-900 hover:border-gray-700'
            }`}
          >
            <p className={`text-sm font-semibold ${direction === key ? 'text-mint-300' : 'text-gray-300'}`}>{label}</p>
            <p className="text-xs text-gray-500 mt-0.5">{sub}</p>
          </button>
        ))}
      </div>

      {/* ── Ethereum side ── */}
      <div className={card}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-100">Ethereum wallet</h2>
          {ethAccount ? (
            <span className="text-xs text-gray-500 font-mono">
              {ethAccount.slice(0, 6)}…{ethAccount.slice(-4)}
              {ethBalance !== null && ` · ${ethBalance} ${assetTicker}`}
            </span>
          ) : null}
        </div>
        {ethAccount ? (
          <p className="text-sm text-mint-300">MetaMask connected.</p>
        ) : metamaskInstalled ? (
          <button onClick={connectWallet} disabled={connecting} className={primaryBtn}>
            {connecting ? 'Connecting…' : 'Connect MetaMask'}
          </button>
        ) : (
          <p className="text-sm text-gray-400">
            MetaMask not detected.{' '}
            <a
              href="https://metamask.io/download/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-mint-400 underline hover:text-mint-300"
            >
              Install MetaMask
            </a>{' '}
            to bridge ERC20 tokens.
          </p>
        )}
      </div>

      {/* ── Bridge form ── */}
      <div className={card + ' space-y-4'}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="bridge-asset" className="block text-xs text-gray-400 mb-1">Asset</label>
            <select id="bridge-asset" value={assetTicker} onChange={(e) => setAssetTicker(e.target.value)} className={input}>
              {assets.map((a) => (
                <option key={a.ticker} value={a.ticker}>{a.ticker}</option>
              ))}
              {assets.length === 0 && <option value="">—</option>}
            </select>
          </div>
          <div>
            <label htmlFor="bridge-amount" className="block text-xs text-gray-400 mb-1">Amount</label>
            <input
              id="bridge-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              autoComplete="off"
              className={input}
            />
            {asset?.maxAmountPerRequest && (
              <p className="text-xs text-gray-500 mt-1">
                Max {asset.maxAmountPerRequest} {assetTicker} per request
              </p>
            )}
            {directionFees && (
              <p className="text-xs text-gray-500 mt-1">
                {(() => {
                  const pct = directionFees.percentage_fee ?? '';
                  const amountValid = /^\d+(\.\d+)?$/.test(amount.trim());
                  const total = amountValid
                    ? totalFee(directionFees.fixed_fee, amount.trim(), pct)
                    : null;
                  const parts = [
                    `fixed ${directionFees.fixed_fee} ${assetTicker}`,
                    pct ? ` + ${pct}${pct.endsWith('%') ? '' : '%'} of amount` : '',
                  ];
                  return total !== null
                    ? `Total fee ${total} ${assetTicker} (${parts.join('')})`
                    : `Fee: fixed ${directionFees.fixed_fee} ${assetTicker}${pct ? ` + ${pct}` : ''}`;
                })()}
              </p>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="bridge-receiver" className="block text-xs text-gray-400 mb-1">{receiverLabel}</label>
          <div className="flex gap-2">
            <input
              id="bridge-receiver"
              value={receiver}
              onChange={e => { setReceiver(e.target.value); setReceiverSuggestion(null); }}
              placeholder={direction === 'e2m' ? 'tmt1…' : '0x…'}
              className={input}
              autoComplete="off"
              spellCheck={false}
            />
            {direction === 'e2m' ? (
              <button
                type="button"
                onClick={useMlAddress}
                disabled={addressLoading}
                title="Fill in a receive address from your Mintlayer wallet"
                className="shrink-0 rounded-lg border border-mint-700 bg-mint-900/30 hover:bg-mint-900/60 px-3 text-xs font-medium text-mint-300 transition-colors disabled:opacity-50"
              >
                {addressLoading ? '…' : 'Use my ML address'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { if (ethAccount) { setReceiver(ethAccount); setReceiverSuggestion(null); } }}
                disabled={!ethAccount}
                title="Fill in your connected MetaMask address"
                className="shrink-0 rounded-lg border border-mint-700 bg-mint-900/30 hover:bg-mint-900/60 px-3 text-xs font-medium text-mint-300 transition-colors disabled:opacity-50"
              >
                Use MetaMask
              </button>
            )}
          </div>
          {receiverSuggestion && (
            <div className="mt-2">
              <AddressSuggestion
                corrected={receiverSuggestion.corrected}
                fixedChars={receiverSuggestion.fixedChars}
                onAccept={() => { setReceiver(receiverSuggestion.corrected); setReceiverSuggestion(null); }}
                onDismiss={() => setReceiverSuggestion(null)}
              />
            </div>
          )}
        </div>

        {direction === 'm2e' && (
          <div>
            <label htmlFor="bridge-totp" className="block text-xs text-gray-400 mb-1">2FA code</label>
            <input
              id="bridge-totp"
              ref={bridgeTotpRef}
              value={bridgeTotp}
              onChange={(e) => setBridgeTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              className={totpInput}
            />
            <p className="mt-1 text-xs text-gray-500">
              Mintlayer → Ethereum signs a wallet transaction — confirm it with your authenticator.
            </p>
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-lg border border-red-800 bg-red-900/30 px-3 py-2 text-red-300 text-sm">{error}</div>
        )}
        {info && (
          <div role="status" className="rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2 text-gray-300 text-sm">{info}</div>
        )}
        {phase !== 'idle' && phaseLabel && (
          <div
            role="status"
            className={`rounded-lg border px-3 py-2 text-sm ${
              phaseState === 'ok'
                ? 'border-mint-700 bg-mint-900/20 text-mint-300'
                : phaseState === 'bad'
                  ? phase === 'manual'
                    ? 'border-amber-800 bg-amber-900/20 text-amber-300'
                    : 'border-red-800 bg-red-950/50 text-red-300'
                  : 'border-gray-700 bg-gray-800/60 text-gray-300'
            }`}
          >
            {phaseState === 'busy' && (
              <span className="inline-flex items-center gap-2">
                <span className="flex gap-1" aria-hidden="true">
                  {[1, 2, 3].map((n) => (
                    <span
                      key={n}
                      className={`w-1.5 h-1.5 rounded-full ${n <= phaseStep ? 'bg-mint-400' : 'bg-gray-600'}`}
                    />
                  ))}
                </span>
              </span>
            )}{' '}
            {phaseLabel}
            {requestUuid && (
              <p className="text-xs text-gray-500 mt-1 font-mono break-all">request {requestUuid}</p>
            )}
            {phaseState !== 'busy' && (
              <button
                type="button"
                onClick={resetForm}
                className="mt-2 block underline font-semibold hover:opacity-80"
              >
                {phaseState === 'ok' ? 'Bridge another' : 'Start over'}
              </button>
            )}
          </div>
        )}

        {!ethAccount ? (
          <button onClick={connectWallet} disabled={connecting} className={primaryBtn}>
            {connecting ? 'Connecting…' : 'Connect MetaMask'}
          </button>
        ) : (
          <button onClick={submit} disabled={busy || !config || !indexerReady} className={primaryBtn}>
            {busy
              ? 'Working…'
              : !indexerReady
                ? 'Waiting for the indexer…'
                : direction === 'e2m'
                  ? `Deposit ${assetTicker || 'tokens'} to bridge`
                  : `Send ${assetTicker || 'tokens'} to bridge`}
          </button>
        )}
      </div>
    </div>
  );
}
