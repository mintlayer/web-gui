"use client";

import { useState, useRef } from "react";
import { watchTx } from "@/lib/txWatcher";
import { submitWithToast } from "@/lib/toastStore";
import { CopyButton } from "@/components/CopyButton";
import { rpc } from '@/lib/client-rpc';
import { stakeTrade, type StakeTradeFailure } from '@/lib/stake-trade-client';
import { TotpField } from '@/components/ui/TotpField';

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
  const [totp, setTotp]                   = useState("");
  const totpRef                           = useRef<HTMLInputElement>(null);

  // Clears + refocuses the 2FA field when a burned code fails, so the user
  // never silently retries a dead code.
  const fail = (r: StakeTradeFailure): Error => {
    if (r.code_consumed) {
      setTotp("");
      window.setTimeout(() => totpRef.current?.focus(), 0);
    }
    return new Error(r.error);
  };

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
      const r = await stakeTrade({
        action: "delegation_stake",
        params: {
          account: 0,
          delegation_id: delegation.delegation_id,
          amount: { decimal: addAmount },
          options: {},
        },
      }, totp);
      if (!r.ok) throw fail(r);
      setTotp("");
      return r.results[0]?.tx_id as string ?? "submitted";
    });

  const handleWithdraw = () =>
    run(async () => {
      const addr = await freshAddress();
      const r = await stakeTrade({
        action: "delegation_withdraw",
        params: {
          account: 0,
          delegation_id: delegation.delegation_id,
          amount: { decimal: withdrawAmount },
          address: addr,
          options: {},
        },
      }, totp);
      if (!r.ok) throw fail(r);
      setTotp("");
      return r.results[0]?.tx_id as string ?? "submitted";
    });

  const handleSweep = () =>
    run(async () => {
      const addr = await freshAddress();
      const r = await stakeTrade({
        action: "staking_sweep_delegation",
        params: {
          account: 0,
          delegation_id: delegation.delegation_id,
          destination_address: addr,
          options: {},
        },
      }, totp);
      if (!r.ok) throw fail(r);
      setTotp("");
      return r.results[0]?.tx_id as string ?? "submitted";
    });

  const loading = state === "loading";
  const needsTotp = totp.length !== 6;

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

      {/* 2FA — one code per staking/withdrawal action on this delegation */}
      <TotpField value={totp} onChange={setTotp} inputRef={totpRef} disabled={loading} />

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
            disabled={loading || !addAmount || needsTotp}
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
            disabled={loading || !withdrawAmount || needsTotp}
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
          disabled={loading || needsTotp}
          className="rounded-lg bg-red-900/40 hover:bg-red-800/60 border border-red-800/60 px-3 py-1 text-xs
                     font-medium text-red-300 transition-colors disabled:opacity-40"
        >
          Sweep All
        </button>
      </div>

      {/* Error */}
      {state === "error" && msg && (
        <p className="text-xs text-red-400 break-all" role="alert">{msg}</p>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function DelegationPanel({ poolId, initialDelegations, network }: Props) {
  const [delegations, setDelegations] = useState<Delegation[]>(initialDelegations);
  const [newState, setNewState]       = useState<ActionState>("idle");
  const [newMsg, setNewMsg]           = useState("");
  const [newTotp, setNewTotp]         = useState("");
  const newTotpRef                    = useRef<HTMLInputElement>(null);

  const hasDelegation = delegations.length > 0;

  const handleCreate = async () => {
    setNewState("loading");
    setNewMsg("");
    try {
      const addr   = await freshAddress();
      // One burn, one intent: create the delegation. Funds are added afterwards
      // via the delegation row's Add input (its own code) — the stake needs the
      // delegation_id that only exists after this transaction.
      const r = await stakeTrade({
        action: "delegation_create",
        params: {
          account: 0,
          pool_id: poolId,
          address: addr,
          options: {},
        },
      }, newTotp);
      if (!r.ok) {
        if (r.code_consumed) {
          setNewTotp("");
          window.setTimeout(() => newTotpRef.current?.focus(), 0);
        }
        throw new Error(r.error);
      }

      setNewState("success");
      setNewMsg("");
      setNewTotp("");

      // Refresh list — the new delegation row appears with its own Add input.
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
            Delegate funds to this pool to earn staking rewards. Creating the delegation is confirmed with your
            2FA code — you add the funds in the next step.
          </p>
          <TotpField value={newTotp} onChange={setNewTotp} inputRef={newTotpRef} disabled={newState === "loading"} />
          <button
            onClick={handleCreate}
            disabled={newState === "loading" || newTotp.length !== 6}
            className="w-full rounded-lg bg-mint-700 hover:bg-mint-600 px-4 py-2 text-sm font-medium text-white
                       transition-colors disabled:opacity-40"
          >
            {newState === "loading" ? "Creating…" : "Create delegation"}
          </button>
          {newMsg && (
            <p className={`text-xs break-all ${newState === "error" ? "text-red-400" : "text-mint-400"}`} role={newState === "error" ? "alert" : "status"}>
              {newMsg}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
