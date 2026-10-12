"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createBridgeSdk,
  deriveProgress,
  loadInFlight,
  saveInFlight,
  clearInFlight,
  IN_FLIGHT_EVENT,
  PROGRESS_POLL_MS,
  DEPOSIT_CONFIRMATIONS,
  getSubscribeUrl,
  isEthTxHash,
  isTxHashLike,
  type BridgeConfig,
  type BridgeFees,
  type BridgeRequestDetail,
  type BridgeProgress,
  type InFlightBridge,
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
import {
  fetchUsdPrices,
  resolveTokenMetadata,
  tickerToPriceId,
  type TokenMetadata,
} from '@/lib/bridge-sdk';
import BridgeTokenPicker, { type PickerAsset } from '@/components/BridgeTokenPicker';
import BridgeHistorySection from '@/components/BridgeHistorySection';
import { appendHistory, updateHistoryStatus } from '@/lib/bridge-sdk/bridge-history';
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
  'w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder:text-gray-600 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600';
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

/** Progress steps shown on the tracked-bridge card. */
const PROGRESS_STEP_LABELS = [
  'Request submitted',
  'Deposit seen — waiting for confirmations',
  'Deposit confirmed',
  'Agents processing the payout',
  'Completed',
];

function mlExplorerBase(networkType: string): string {
  return networkType === 'mainnet'
    ? 'https://explorer.mintlayer.org'
    : 'https://lovelace.explorer.mintlayer.org';
}

function ethExplorerBase(flavor: string): string {
  return flavor === '' ? 'https://etherscan.io' : 'https://sepolia.etherscan.io';
}

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
  // Tracked (in-flight) bridge — persisted so a refresh restores the card.
  const [tracked, setTracked] = useState<InFlightBridge | null>(() => loadInFlight());
  const [trackedProgress, setTrackedProgress] = useState<BridgeProgress | null>(null);
  const [trackedRequest, setTrackedRequest] = useState<BridgeRequestDetail | null>(null);
  const [historyToken, setHistoryToken] = useState(0);
  const wsThrottleRef = useRef(0);
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

  // ── Display metadata + USD prices (strictly display-only) ────────────────
  const [metaMap, setMetaMap] = useState<Record<string, TokenMetadata | null>>({});
  const [usdPrice, setUsdPrice] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const missing = assets.filter((a) => a.mlTokenId && !(a.ticker in metaMap));
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (a) => [a.ticker, await resolveTokenMetadata(a.mlTokenId!)] as const),
    ).then((entries) => {
      if (cancelled) return;
      setMetaMap((prev) => {
        const next = { ...prev };
        for (const [ticker, meta] of entries) next[ticker] = meta;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets]);

  useEffect(() => {
    let cancelled = false;
    setUsdPrice(null);
    const priceId = tickerToPriceId(assetTicker);
    if (!priceId) return;
    void fetchUsdPrices([priceId]).then((prices) => {
      if (!cancelled && typeof prices[priceId] === 'number') setUsdPrice(prices[priceId]);
    });
    return () => {
      cancelled = true;
    };
  }, [assetTicker]);

  const pickerAssets: PickerAsset[] = useMemo(
    () =>
      assets.map((a) => ({
        ticker: a.ticker,
        name: metaMap[a.ticker]?.name ?? a.ticker,
        tags: metaMap[a.ticker]?.tags ?? [],
      })),
    [assets, metaMap],
  );

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

  /** Persist a freshly broadcast bridge so the card survives refreshes. */
  function trackRequest(uuid: string, txHash: string) {
    saveInFlight({
      uuid,
      txHash,
      asset: assetTicker,
      amount: amount.trim(),
      receiver: receiver.trim(),
      destinationChain: direction === 'e2m' ? 'ML' : 'ETH',
      startedAt: new Date().toISOString(),
      lastStep: 1,
    });
    appendHistory({
      uuid,
      direction,
      asset: assetTicker,
      amount: amount.trim(),
      receiver: receiver.trim(),
      startedAt: new Date().toISOString(),
    });
    setHistoryToken((t) => t + 1);
    setPhase('polling');
  }

  // ── Tracked-bridge monitor ──────────────────────────────────────────────
  // The 10s poll on GET /bridge-request/:uuid is the source of truth; the
  // /subscribe WebSocket only accelerates it (min 1.5s between prompted
  // polls). Polling stops on any terminal state.
  const pollTracked = useCallback(async () => {
    const current = loadInFlight();
    if (!current) return;
    try {
      const detail: BridgeRequestDetail = await sdk.getBridgeRequest(current.uuid);
      const next = deriveProgress(detail);
      // Fresh re-read doubles as both the takeover guard (a newer bridge's
      // progress must not be published under the old request) and the save
      // base (keeps lastStep monotonic against overlapping polls).
      const latest = loadInFlight();
      if (latest?.uuid !== current.uuid) return;
      setTrackedRequest(detail);
      setTrackedProgress(next);
      if (next.kind !== 'in-progress') {
        setPhase(next.kind === 'completed' ? 'done' : next.kind === 'manual' ? 'manual' : 'failed');
      }
      setRequestStatus(next.rawStatus);
      const advanced = next.step > latest.lastStep;
      // First sight of the deposit hash (ML→ETH submits without one) —
      // persisted so the card links it even across refreshes.
      const depositHashArrived = !latest.depositTxHash && next.depositTxHash;
      if (advanced || depositHashArrived) {
        saveInFlight({
          ...latest,
          lastStep: Math.max(latest.lastStep, next.step),
          depositTxHash: latest.depositTxHash ?? next.depositTxHash ?? undefined,
        });
      }
      updateHistoryStatus(current.uuid, next.rawStatus);
    } catch {
      /* transient — the next poll retries; unknown state keeps polling */
    }
  }, []);

  useEffect(() => {
    const onFlight = () => setTracked(loadInFlight());
    window.addEventListener(IN_FLIGHT_EVENT, onFlight);
    return () => window.removeEventListener(IN_FLIGHT_EVENT, onFlight);
  }, []);

  useEffect(() => {
    if (!tracked) return;
    if (trackedProgress && trackedProgress.kind !== 'in-progress') return;
    void pollTracked();
    const id = setInterval(() => void pollTracked(), PROGRESS_POLL_MS);
    return () => clearInterval(id);
  }, [tracked, trackedProgress?.kind, pollTracked]);

  useEffect(() => {
    const uuid = tracked?.uuid;
    if (!uuid) return;
    if (trackedProgress && trackedProgress.kind !== 'in-progress') return;
    let socket: WebSocket | null = null;
    let closed = false;
    try {
      socket = new WebSocket(getSubscribeUrl());
      socket.onmessage = (event) => {
        if (closed) return;
        const payload =
          typeof event.data === 'string' ? event.data : String(event.data ?? '');
        if (
          payload.includes(uuid) &&
          Date.now() - wsThrottleRef.current > 1_500
        ) {
          wsThrottleRef.current = Date.now();
          void pollTracked();
        }
      };
      socket.onerror = () => {
        /* polling remains the source of truth */
      };
    } catch {
      /* no WebSocket support — polling only */
    }
    return () => {
      closed = true;
      socket?.close();
    };
  }, [tracked?.uuid, trackedProgress?.kind, pollTracked]);

  function dismissTracked() {
    clearInFlight();
    setTracked(null);
    setTrackedProgress(null);
    setTrackedRequest(null);
    setRequestUuid(null);
    setRequestStatus(null);
  }

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
    // Starting a new bridge while one is already in flight takes over the
    // single tracked-bridge slot — ask before replacing it.
    const existingFlight = loadInFlight();
    if (existingFlight && (!trackedProgress || trackedProgress.kind === 'in-progress')) {
      if (
        !window.confirm(
          'You already have a bridge in progress. Start a new one and track it instead? The current one keeps processing in the background.',
        )
      ) {
        return;
      }
    }
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
        trackRequest(res.bridge_request_uuid, txHash);
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
        trackRequest(res.bridge_request_uuid, '');
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
              ? 'Agents are processing…'
              : phase === 'done'
                ? 'Bridge completed — tokens arrived.'
                : phase === 'failed'
                  ? 'Bridge failed.'
                  : phase === 'manual'
                    ? 'Escalated for manual review — support will look at this request.'
                    : '';

  return (
    <div className="space-y-6">
      {configError && (
        <div className="rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-300">
          Bridge service unreachable: {configError}
        </div>
      )}

      {/* ── Direction toggle ── */}
      <div
        role="radiogroup"
        aria-label="Bridge direction"
        className="grid grid-cols-2 gap-3"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next: Direction = direction === 'e2m' ? 'm2e' : 'e2m';
            setDirection(next);
            setError(null);
            setInfo(null);
          }
        }}
      >
        {(
          [
            { key: 'e2m', label: 'Ethereum → Mintlayer', sub: 'Deposit ERC20, receive ML tokens' },
            { key: 'm2e', label: 'Mintlayer → Ethereum', sub: 'Bridge ML tokens back to ERC20' },
          ] as const
        ).map(({ key, label, sub }) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={direction === key}
            tabIndex={direction === key ? 0 : -1}
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
            <label id="bridge-asset-label" className="block text-xs text-gray-400 mb-1">Asset</label>
            <BridgeTokenPicker
              assets={pickerAssets}
              value={assetTicker}
              onChange={(t) => setAssetTicker(t)}
              metadata={metaMap}
            />
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
            {usdPrice !== null && /^\d+(\.\d+)?$/.test(amount.trim()) && parseFloat(amount.trim()) > 0 && (
              <p className="text-xs text-gray-500 mt-1">
                ≈ ${(parseFloat(amount.trim()) * usdPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })} USD
              </p>
            )}
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

        {asset && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2 text-xs text-gray-400">
            {metaMap[assetTicker]?.description && (
              <p className="w-full line-clamp-2 text-gray-400">{metaMap[assetTicker]?.description}</p>
            )}
            <span className="font-medium text-gray-300">
              {metaMap[assetTicker]?.name && metaMap[assetTicker]?.name !== assetTicker
                ? `${metaMap[assetTicker]?.name} (${assetTicker})`
                : assetTicker}
            </span>
            {usdPrice !== null && <span>· ${usdPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>}
            {asset.maxAmountPerRequest && <span>· max {asset.maxAmountPerRequest} per request</span>}
            {(metaMap[assetTicker]?.tags ?? []).slice(0, 4).map((tag) => (
              <span key={tag} className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-300">
                {tag}
              </span>
            ))}
          </div>
        )}

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
        {tracked && trackedProgress && (
          <div
            role="status"
            className={`rounded-lg border px-3 py-3 text-sm ${
              trackedProgress.kind === 'completed'
                ? 'border-mint-700 bg-mint-900/20'
                : trackedProgress.kind === 'failed'
                  ? 'border-red-800 bg-red-950/50'
                  : trackedProgress.kind === 'manual'
                    ? 'border-amber-800 bg-amber-900/20'
                    : 'border-gray-700 bg-gray-800/60'
            }`}
          >
            <p className="font-semibold text-gray-100 mb-2">
              Bridging {tracked.amount} {tracked.asset} →{" "}
              {tracked.destinationChain === 'ML' ? 'Mintlayer' : 'Ethereum'}
            </p>
            <ol className="space-y-1.5 mb-2">
              {PROGRESS_STEP_LABELS.map((label, idx) => {
                const stepNo = idx + 1;
                const reached = trackedProgress.step >= stepNo;
                const isTerminal = stepNo === 5;
                const terminalMismatch =
                  isTerminal && trackedProgress.kind !== 'completed';
                return (
                  <li key={label} className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        reached
                          ? terminalMismatch
                            ? trackedProgress.kind === 'manual'
                              ? 'bg-amber-400'
                              : 'bg-red-400'
                            : 'bg-mint-400'
                          : 'bg-gray-600'
                      } ${reached && !terminalMismatch && stepNo === trackedProgress.step && trackedProgress.kind === 'in-progress' ? 'animate-pulse' : ''}`}
                    />
                    <span className={reached ? 'text-gray-200' : 'text-gray-500'}>
                      {terminalMismatch
                        ? trackedProgress.kind === 'manual'
                          ? 'Needs manual processing — funds are safe, this takes longer'
                          : 'Bridge request failed — contact support with the request ID'
                        : label}
                    </span>
                  </li>
                );
              })}
            </ol>
            {(tracked.txHash || tracked.depositTxHash || trackedProgress.mlTxHash) && (
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs mb-1">
                {(tracked.txHash || tracked.depositTxHash) &&
                  isEthTxHash(tracked.txHash || tracked.depositTxHash || '') && (
                    <a
                      href={`${ethExplorerBase(flavor)}/tx/${tracked.txHash || tracked.depositTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-mint-300 underline hover:opacity-80"
                    >
                      Deposit on Etherscan ↗
                    </a>
                  )}
                {trackedProgress.mlTxHash && isTxHashLike(trackedProgress.mlTxHash) && (
                  <a
                    href={`${mlExplorerBase(networkType)}/transaction/${trackedProgress.mlTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-mint-300 underline hover:opacity-80"
                  >
                    Payout on the Mintlayer explorer ↗
                  </a>
                )}
              </p>
            )}
            <p className="text-xs text-gray-500 font-mono break-all">
              request {tracked.uuid}
            </p>
            {trackedProgress.kind !== 'in-progress' ? (
              <div className="flex gap-3 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    dismissTracked();
                    resetForm();
                  }}
                  className="underline font-semibold hover:opacity-80 text-gray-200"
                >
                  Bridge another
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={dismissTracked}
                className="mt-2 text-xs text-gray-500 underline hover:opacity-80"
              >
                Stop tracking (the bridge keeps processing)
              </button>
            )}
          </div>
        )}

        {(phase === 'approve' || phase === 'deposit' || phase === 'signing' || phase === 'submitting') && phaseLabel && (
          <div
            role="status"
            className="rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2 text-sm text-gray-300"
          >
            <span className="inline-flex items-center gap-2">
              <span className="flex gap-1" aria-hidden="true">
                {[1, 2, 3].map((n) => (
                  <span
                    key={n}
                    className={`w-1.5 h-1.5 rounded-full ${
                      n <= (phase === 'approve' ? 1 : phase === 'deposit' ? 2 : phase === 'signing' ? 2 : 3)
                        ? 'bg-mint-400'
                        : 'bg-gray-600'
                    }`}
                  />
                ))}
              </span>
            </span>{' '}
            {phaseLabel}
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

      <BridgeHistorySection
        refreshToken={historyToken}
        networkType={networkType}
        flavor={flavor}
      />
    </div>
  );
}
