"use client";

import { useState } from "react";
import { watchTx } from "@/lib/txWatcher";
import { submitWithToast } from "@/lib/toastStore";
import { CopyButton } from "@/components/CopyButton";
import { rpc } from '@/lib/client-rpc';

interface Delegation {
  delegation_id: string;
  pool_id: string;
  balance: { atoms: string; decimal: string };
}

interface Props {
  poolId: string;
  initialDelegations: Delegation[];
  network: string;
}

type ActionState = "idle" | "loading" | "success" | "error";

/** Get the first unused wallet address, generating a new one only if all are used. */
async function freshAddress(): Promise<string> {
  const addresses = await rpc<Array<{ address: string; used: boolean; purpose: string }>>(
    "address_show", { account: 0, include_change_addresses: false }
  );
  const unused = addresses.find(a => a.purpose === "Receive" && !a.used);
  if (unused) return unused.address;
  const result = await rpc<{ address: string }>("address_new", { account: 0 });
  return result.address;
}

// ── Per-delegation row ────────────────────────────────────────────────────────

function DelegationRow({
  delegation,
  network,
  onUpdated,
}: {
  delegation: Delegation;
  network: string;
  onUpdated: (updated: Delegation | null) => void;
}) {
  const [addAmount, setAddAmount]         = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [state, setState]                 = useState<ActionState>("idle");
  const [msg, setMsg]                     = useState("");

  const run = async (fn: () => Promise<string>) => {
    setState("loading");
    setMsg("");
    try {
      await submitWithToast(fn, watchTx);
      setState("success");
      setMsg("");
      // Refresh delegation balance
      const list = await rpc<Delegation[]>("delegation_list_ids", { account: 0 });
      const updated = list.find(d => d.delegation_id === delegation.delegation_id) ?? null;
      onUpdated(updated);
      setAddAmount("");
      setWithdrawAmount("");
    } catch (err) {
      setMsg((err as Error).message);
      setState("error");
    }
  };

  const handleAdd = () =>
    run(async () => {
      const res = await rpc<{ tx_id: string }>("delegation_stake", {
        account: 0,
        delegation_id: delegation.delegation_id,
        amount: { decimal: addAmount },
        options: {},
      });
      return res.tx_id;
    });

  const handleWithdraw = () =>
    run(async () => {
      const addr = await freshAddress();
      const res = await rpc<{ tx_id: string }>("delegation_withdraw", {
        account: 0,
        delegation_id: delegation.delegation_id,
        amount: { decimal: withdrawAmount },
        address: addr,
        options: {},
      });
      return res.tx_id;
    });

  const handleSweep = () =>
    run(async () => {
      const addr = await freshAddress();
      const res = await rpc<{ tx_id: string }>("staking_sweep_delegation", {
        account: 0,
        delegation_id: delegation.delegation_id,
        destination_address: addr,
        options: {},
      });
      return res.tx_id;
    });

  const loading = state === "loading";

  return (
    <div className="rounded-lg bg-gray-800/50 border border-gray-700/50 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-1 flex-wrap">
            <a
              href={`${network === 'testnet' ? 'https://lovelace.explorer.mintlayer.org' : 'https://explorer.mintlayer.org'}/delegation/${delegation.delegation_id}`}
              target="_blank"
              rel="noopener"
              className="font-mono text-xs text-mint-400 hover:text-mint-300 break-all transition-colors"
            >
              {delegation.delegation_id}
            </a>
            <CopyButton value={delegation.delegation_id} title="Copy delegation ID" />
          </span>
          <p className="font-mono text-sm text-gray-200 mt-0.5">
            {delegation.balance.decimal} <span className="text-gray-500 text-xs">ML staked</span>
          </p>
        </div>
      </div>

      {/* Actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {/* Add funds */}
        <div className="flex gap-1.5">
          <input
            type="number" min="0" step="any" placeholder="Amount ML"
            value={addAmount} onChange={e => setAddAmount(e.target.value)}
            disabled={loading}
            className="flex-1 min-w-0 rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600
                       px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-mint-600 disabled:opacity-50"
          />
          <button
            onClick={handleAdd}
            disabled={loading || !addAmount}
            className="rounded-lg bg-mint-700 hover:bg-mint-600 px-3 py-1.5 text-xs font-medium text-white
                       transition-colors disabled:opacity-40 shrink-0"
          >
            Add
          </button>
        </div>

        {/* Withdraw */}
        <div className="flex gap-1.5">
          <input
            type="number" min="0" step="any" placeholder="Amount ML"
            value={withdrawAmount} onChange={e => setWithdrawAmount(e.target.value)}
            disabled={loading}
            className="flex-1 min-w-0 rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600
                       px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-mint-600 disabled:opacity-50"
          />
          <button
            onClick={handleWithdraw}
            disabled={loading || !withdrawAmount}
            className="rounded-lg bg-gray-700 hover:bg-gray-600 px-3 py-1.5 text-xs font-medium text-gray-200
                       transition-colors disabled:opacity-40 shrink-0"
          >
            Withdraw
          </button>
        </div>
      </div>

      {/* Sweep */}
      <div className="flex items-center justify-between pt-1 border-t border-gray-700/50">
        <p className="text-xs text-gray-600">Withdraw all funds and close delegation</p>
        <button
          onClick={() => {
            if (!confirm("Sweep all funds out of this delegation?")) return;
            handleSweep();
          }}
          disabled={loading}
          className="rounded-lg bg-red-900/40 hover:bg-red-800/60 border border-red-800/60 px-3 py-1 text-xs
                     font-medium text-red-300 transition-colors disabled:opacity-40"
        >
          Sweep All
        </button>
      </div>

      {/* Error */}
      {state === "error" && msg && (
        <p className="text-xs text-red-400 break-all">{msg}</p>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function DelegationPanel({ poolId, initialDelegations, network }: Props) {
  const [delegations, setDelegations] = useState<Delegation[]>(initialDelegations);
  const [newAmount, setNewAmount]     = useState("");
  const [newState, setNewState]       = useState<ActionState>("idle");
  const [newMsg, setNewMsg]           = useState("");

  const hasDelegation = delegations.length > 0;

  const handleCreate = async () => {
    setNewState("loading");
    setNewMsg("");
    try {
      const addr   = await freshAddress();
      const result = await rpc<{ delegation_id: string; tx_id: string }>("delegation_create", {
        account: 0,
        pool_id: poolId,
        address: addr,
        options: {},
      });
      const delegId = result.delegation_id;

      await submitWithToast(
        async () => {
          const res = await rpc<{ tx_id: string }>("delegation_stake", {
            account: 0,
            delegation_id: delegId,
            amount: { decimal: newAmount },
            options: {},
          });
          return res.tx_id;
        },
        watchTx,
      );

      setNewState("success");
      setNewMsg("");
      setNewAmount("");

      // Refresh list
      const list = await rpc<Delegation[]>("delegation_list_ids", { account: 0 });
      setDelegations(list.filter(d => d.pool_id === poolId));
    } catch (err) {
      setNewMsg((err as Error).message);
      setNewState("error");
    }
  };

  const updateDelegation = (updated: Delegation | null, id: string) => {
    if (updated === null) {
      setDelegations(prev => prev.filter(d => d.delegation_id !== id));
    } else {
      setDelegations(prev => prev.map(d => d.delegation_id === id ? updated : d));
    }
  };

  return (
    <div className="mt-4 border-t border-gray-800 pt-4 space-y-3">
      <p className="text-xs text-gray-500 uppercase tracking-wider">
        Delegation <span className="text-gray-400 ml-1">{hasDelegation ? "active" : "none"}</span>
      </p>

      {/* Existing delegation */}
      {delegations.map(d => (
        <DelegationRow
          key={d.delegation_id}
          delegation={d}
          network={network}
          onUpdated={updated => updateDelegation(updated, d.delegation_id)}
        />
      ))}

      {/* Create form - only shown when no delegation exists */}
      {!hasDelegation && (
        <div className="rounded-lg bg-gray-800/50 border border-gray-700/50 p-4 space-y-3">
          <p className="text-xs text-gray-400">
            Delegate funds to this pool to earn staking rewards.
          </p>
          <div className="flex gap-2">
            <input
              type="number" min="0" step="any" placeholder="Amount ML"
              value={newAmount} onChange={e => setNewAmount(e.target.value)}
              disabled={newState === "loading"}
              className="flex-1 rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600
                         px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600 disabled:opacity-50"
            />
            <button
              onClick={handleCreate}
              disabled={newState === "loading" || !newAmount}
              className="rounded-lg bg-mint-700 hover:bg-mint-600 px-4 py-2 text-sm font-medium text-white
                         transition-colors disabled:opacity-40"
            >
              {newState === "loading" ? "…" : "Delegate"}
            </button>
          </div>
          {newMsg && (
            <p className={`text-xs break-all ${newState === "error" ? "text-red-400" : "text-mint-400"}`}>
              {newMsg}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
