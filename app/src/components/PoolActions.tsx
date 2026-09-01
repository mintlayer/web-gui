"use client";

import { useState } from "react";
import { watchTx } from "@/lib/txWatcher";
import { submitWithToast } from "@/lib/toastStore";
import { rpc } from '@/lib/client-rpc';

async function freshAddress(): Promise<string> {
  const addresses = await rpc<Array<{ address: string; used: boolean; purpose: string }>>(
    "address_show", { account: 0, include_change_addresses: false }
  );
  const unused = addresses.find(a => a.purpose === "Receive" && !a.used);
  if (unused) return unused.address;
  const result = await rpc<{ address: string }>("address_new", { account: 0 });
  return result.address;
}

// ── Create Pool Form ──────────────────────────────────────────────────────────

interface CreatePoolProps {
  initialDecommissionAddress: string;
  onSuccess?: () => void;
}

export function CreatePoolForm({ initialDecommissionAddress, onSuccess }: CreatePoolProps) {
  const [amount,       setAmount]       = useState("");
  const [costPerBlock, setCostPerBlock] = useState("0");
  const [marginPct,    setMarginPct]    = useState("");
  const [decommAddr,   setDecommAddr]   = useState(initialDecommissionAddress);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [success,      setSuccess]      = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const marginRatio = (parseFloat(marginPct) / 100).toFixed(4);
      await submitWithToast(
        async () => {
          const res = await rpc<{ tx_id: string }>("staking_create_pool", {
            account: 0,
            amount:                    { decimal: amount },
            cost_per_block:            { decimal: costPerBlock || "0" },
            margin_ratio_per_thousand: marginRatio,
            decommission_address:      decommAddr,
            staker_address:            null,
            vrf_public_key:            null,
            options:                   {},
          });
          return res.tx_id;
        },
        watchTx,
      );
      setSuccess(true);
      setAmount(""); setMarginPct(""); setCostPerBlock("0");
      onSuccess?.();
      // Refresh decommission address for next pool
      const addr = await freshAddress();
      setDecommAddr(addr);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-700 bg-red-900/30 p-3 text-red-300 text-sm">{error}</div>
      )}
      {success && (
        <div className="rounded-lg border border-mint-700 bg-mint-900/30 p-3 text-mint-300 text-sm">
          Pool creation submitted - watch the toast for confirmation.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-gray-400 mb-1">
            Pledge amount <span className="text-gray-600">(min 40,000 ML)</span>
          </label>
          <input
            type="number" min="40000" step="any" required placeholder="40000"
            value={amount} onChange={e => setAmount(e.target.value)} disabled={loading}
            className="w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600
                       px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600 disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">
            Cost per block <span className="text-gray-600">(ML)</span>
          </label>
          <input
            type="number" min="0" step="any" placeholder="0"
            value={costPerBlock} onChange={e => setCostPerBlock(e.target.value)} disabled={loading}
            className="w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600
                       px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600 disabled:opacity-50"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-gray-400 mb-1">Margin ratio (%)</label>
        <input
          type="number" min="0.1" max="100" step="0.1" placeholder="5" required
          value={marginPct} onChange={e => setMarginPct(e.target.value)} disabled={loading}
          className="w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600
                     px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600 disabled:opacity-50"
        />
        <p className="text-xs text-gray-600 mt-1">0.1%–100%. Your cut of block rewards before distribution to delegators.</p>
      </div>

      <div>
        <label className="block text-xs text-gray-400 mb-1">Decommission address</label>
        <input
          type="text" required
          value={decommAddr} onChange={e => setDecommAddr(e.target.value)} disabled={loading}
          className="w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-300 placeholder-gray-600
                     px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600 disabled:opacity-50"
        />
        <p className="text-xs text-yellow-600 mt-1">
          Controls who can decommission the pool. Pre-filled with a fresh wallet address - save it.
        </p>
      </div>

      <button
        type="submit" disabled={loading || !amount || !marginPct}
        className="w-full rounded-lg bg-mint-700 hover:bg-mint-600 px-4 py-2 text-sm font-semibold text-white
                   transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {loading && (
          <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
        {loading ? "Submitting…" : "Create Pool"}
      </button>
    </form>
  );
}

// ── Create Pool Modal ─────────────────────────────────────────────────────────

interface CreatePoolModalProps {
  initialDecommissionAddress: string;
}

export function CreatePoolModal({ initialDecommissionAddress }: CreatePoolModalProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-mint-700 hover:bg-mint-600
                   px-4 py-2 text-sm font-semibold text-white transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Create Pool
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="relative bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-lg mx-4 shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-gray-100">Create New Pool</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-gray-500 hover:text-gray-300 transition-colors"
                aria-label="Close"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <CreatePoolForm
              initialDecommissionAddress={initialDecommissionAddress}
              onSuccess={() => setOpen(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}

// ── Decommission button ───────────────────────────────────────────────────────

interface DecommissionProps {
  poolId: string;
}

export function DecommissionButton({ poolId }: DecommissionProps) {
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const handleClick = async () => {
    if (!confirm("Are you sure you want to decommission this pool? This cannot be undone.")) return;
    setLoading(true);
    setError(null);
    try {
      await submitWithToast(
        async () => {
          const res = await rpc<{ tx_id: string }>("staking_decommission_pool", {
            account:        0,
            pool_id:        poolId,
            output_address: null,
            options:        {},
          });
          return res.tx_id;
        },
        watchTx,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        onClick={handleClick} disabled={loading}
        className="rounded-lg bg-red-900/40 hover:bg-red-800/60 border border-red-800 px-3 py-1.5 text-xs
                   font-medium text-red-300 transition-colors disabled:opacity-50 flex items-center gap-1.5"
      >
        {loading && (
          <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
        {loading ? "Submitting…" : "Dismiss Pool"}
      </button>
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </div>
  );
}
