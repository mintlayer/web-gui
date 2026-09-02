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
  switchChain,
} from '@/lib/evm';

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
  | 'failed';

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
  failed: { label: 'Bridge failed', step: 3 },
  manual: { label: 'Escalated for manual review', step: 3 },
};

export default function BridgePanel() {
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [fees, setFees] = useState<BridgeFees | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const [direction, setDirection] = useState<Direction>('e2m');
  const [assetTicker, setAssetTicker] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [receiver, setReceiver] = useState('');

  const [ethAccount, setEthAccount] = useState<string | null>(null);
  const [ethBalance, setEthBalance] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [mlAddress, setMlAddress] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [requestUuid, setRequestUuid] = useState<string | null>(null);
  const [requestStatus, setRequestStatus] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
        const network = cfg.network_type ?? 'mainnet';
        const flavorCfg =
          cfg.eth_flavor_specific_config?.[network === 'mainnet' ? 'mainnet' : 'sepolia'] ??
          cfg.eth_flavor_specific_config?.[''] ??
          null;
        const tickers = Object.keys(cfg.ml_tokens ?? {});
        setAssetTicker((prev) => prev || tickers[0] || '');
        void flavorCfg;
      } catch (err) {
        if (!cancelled) setConfigError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Own ML address (receive side for E2M) ───────────────────────────────────
  const loadMlAddress = useCallback(async () => {
    try {
      const res = await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'address_show',
          params: { account: 0, include_change_addresses: false },
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        result?: { address: string; used: boolean; purpose: string }[];
      };
      if (!data.ok || !Array.isArray(data.result)) return;
      const first = data.result.find((a) => a.purpose === 'Receive' && !a.used) ?? data.result[0];
      if (first) setMlAddress(first.address);
    } catch {
      /* dashboard shows wallet errors elsewhere */
    }
  }, []);
  useEffect(() => {
    loadMlAddress();
  }, [loadMlAddress]);

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
          setPhase(status === 'completed' ? 'done' : 'failed');
        }
      } catch {
        /* transient poll errors are retried on the next tick */
      }
    }, 10_000);
  }

  useEffect(() => stopPolling, []);

  async function submit() {
    setError(null);
    if (!asset) {
      setError('No bridged asset selected.');
      return;
    }
    if (!amount.trim() || !receiver.trim()) {
      setError(direction === 'e2m' ? 'Amount and Mintlayer address are required.' : 'Amount and Ethereum address are required.');
      return;
    }
    if (!/^\d+(\.\d+)?$/.test(amount.trim())) {
      setError('Amount must be a positive decimal number.');
      return;
    }

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
        const signed = await fetch('/api/bridge/ml-intent-tx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token_id: asset.mlTokenId,
            amount: amount.trim(),
            intent: receiver.trim(),
          }),
        }).then((r) => r.json() as Promise<{ ok: boolean; error?: string; raw_transaction?: string; intent?: string }>);
        if (!signed.ok || !signed.raw_transaction || !signed.intent) {
          throw new Error(signed.error ?? 'Failed to create the bridge transaction.');
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
      const e = err as { code?: number; message?: string };
      setError(e.message ?? 'Bridge request failed.');
      setPhase('idle');
    }
  }

  const busy = phase === 'approve' || phase === 'deposit' || phase === 'signing' || phase === 'submitting' || phase === 'polling';
  const receiverLabel = direction === 'e2m' ? 'Your Mintlayer address (receiver)' : 'Your Ethereum address (receiver)';
  const receiverValue = direction === 'e2m' ? mlAddress ?? '' : ethAccount ?? '';

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
                  : '';

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-amber-800 bg-amber-900/20 px-4 py-3 text-xs text-amber-300">
        The bridge moves fungible tokens between Ethereum and Mintlayer through a
        2-of-2 multisig agent setup. Deposits require network confirmations —
        keep this page open until the request completes.
      </div>

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
            onClick={() => { setDirection(key); setError(null); }}
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
            <label className="block text-xs text-gray-400 mb-1">Asset</label>
            <select value={assetTicker} onChange={(e) => setAssetTicker(e.target.value)} className={input}>
              {assets.map((a) => (
                <option key={a.ticker} value={a.ticker}>{a.ticker}</option>
              ))}
              {assets.length === 0 && <option value="">—</option>}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Amount</label>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              className={input}
            />
            {directionFees && (
              <p className="text-xs text-gray-500 mt-1">
                Fee: {directionFees.fixed_fee} {assetTicker}
                {directionFees.percentage_fee ? ` + ${directionFees.percentage_fee}` : ''}
              </p>
            )}
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1">{receiverLabel}</label>
          {direction === 'e2m' ? (
            <input value={receiver} onChange={(e) => setReceiver(e.target.value)} placeholder="tmt1…" className={input} />
          ) : (
            <input value={receiver} onChange={(e) => setReceiver(e.target.value)} placeholder="0x…" className={input} />
          )}
          {direction === 'e2m' && mlAddress && !receiver && (
            <button
              type="button"
              onClick={() => setReceiver(mlAddress)}
              className="text-xs text-mint-400 hover:text-mint-300 mt-1"
            >
              Use your wallet address
            </button>
          )}
          {direction === 'm2e' && ethAccount && !receiver && (
            <button
              type="button"
              onClick={() => setReceiver(ethAccount)}
              className="text-xs text-mint-400 hover:text-mint-300 mt-1"
            >
              Use your MetaMask address
            </button>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-red-800 bg-red-900/30 px-3 py-2 text-red-300 text-sm">{error}</div>
        )}
        {phase !== 'idle' && phaseLabel && (
          <div className="rounded-lg border border-mint-700 bg-mint-900/20 px-3 py-2 text-mint-300 text-sm">
            {phaseLabel}
            {requestUuid && (
              <p className="text-xs text-gray-500 mt-1 font-mono break-all">request {requestUuid}</p>
            )}
          </div>
        )}

        {!ethAccount ? (
          <button onClick={connectWallet} disabled={connecting} className={primaryBtn}>
            {connecting ? 'Connecting…' : 'Connect MetaMask'}
          </button>
        ) : (
          <button onClick={submit} disabled={busy || !config} className={primaryBtn}>
            {busy
              ? 'Working…'
              : direction === 'e2m'
                ? `Deposit ${assetTicker || 'tokens'} to bridge`
                : `Send ${assetTicker || 'tokens'} to bridge`}
          </button>
        )}
      </div>
    </div>
  );
}
