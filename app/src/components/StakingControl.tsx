"use client";

import { useState } from "react";
import { rpc } from '@/lib/client-rpc';

interface Props {
  initialStatus: "Staking" | "NotStaking";
}

export default function StakingControl({ initialStatus }: Props) {
  const [status, setStatus]   = useState(initialStatus);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const isStaking = status === "Staking";

  const toggle = async () => {
    setLoading(true);
    setError(null);
    try {
      if (isStaking) {
        await rpc("staking_stop",  { account: 0 });
        setStatus("NotStaking");
      } else {
        await rpc("staking_start", { account: 0 });
        setStatus("Staking");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2">
        <span className={`w-3 h-3 rounded-full ${isStaking ? "bg-mint-400 animate-pulse" : "bg-gray-600"}`} />
        <span className={`text-lg font-semibold ${isStaking ? "text-mint-400" : "text-gray-400"}`}>
          {isStaking ? "Staking" : "Not staking"}
        </span>
      </div>

      <button
        onClick={toggle}
        disabled={loading}
        className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
          isStaking
            ? "bg-red-800 hover:bg-red-700 text-red-100"
            : "bg-mint-700 hover:bg-mint-600 text-white"
        }`}
      >
        {loading ? "…" : isStaking ? "Stop" : "Start"}
      </button>

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
