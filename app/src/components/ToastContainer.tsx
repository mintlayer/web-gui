"use client";

import { useSyncExternalStore } from "react";
import { toastStore, type TxToast } from "@/lib/toastStore";

const EMPTY_TOASTS: TxToast[] = [];

function TxToastItem({ toast }: { toast: TxToast }) {
  const isPending   = toast.status === "pending";
  const isConfirmed = toast.status === "confirmed";
  const isFailed    = toast.status === "failed";
  const isUntracked = toast.status === "untracked";

  return (
    <div
      className={`flex items-start gap-3 rounded-xl border p-4 shadow-2xl backdrop-blur-sm min-w-72 max-w-sm transition-all ${
        isPending   ? "bg-gray-900/95 border-gray-700"        :
        isConfirmed ? "bg-gray-900/95 border-mint-700"        :
        isUntracked ? "bg-gray-900/95 border-gray-700"        :
                      "bg-gray-900/95 border-red-800"
      }`}
    >
      {/* Icon */}
      <div className="shrink-0 mt-0.5">
        {isPending && (
          <svg className="animate-spin w-4 h-4 text-mint-400" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
        {isConfirmed && (
          <svg className="w-4 h-4 text-mint-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
        {isFailed && (
          <svg className="w-4 h-4 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-semibold mb-1 ${isConfirmed ? "text-mint-400" : isFailed ? "text-red-400" : isUntracked ? "text-gray-400" : "text-gray-300"}`}>
          {isPending   && (toast.stale ? "Still pending — check the explorer for status." : "Transaction pending…")}
          {isConfirmed && (toast.blockHeight != null
            ? `Confirmed at block #${toast.blockHeight.toLocaleString()}`
            : "Confirmed")}
          {isFailed    && `Failed: ${toast.errorMessage ?? "unknown error"}`}
          {isUntracked && (toast.errorMessage ?? "Confirmation not tracked — check the explorer.")}
        </p>
        <a
          href={toast.explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-gray-500 hover:text-mint-400 underline underline-offset-2 transition-colors block truncate"
        >
          {toast.txId.slice(0, 16)}…{toast.txId.slice(-8)}
        </a>
      </div>

      {/* Dismiss */}
      <button
        onClick={() => toastStore.dismiss(toast.txId)}
        className="shrink-0 text-gray-600 hover:text-gray-300 transition-colors"
        aria-label="Dismiss"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

export default function ToastContainer() {
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, () => EMPTY_TOASTS);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-4 right-4 z-[60] flex flex-col gap-2 pointer-events-none"
      role={toasts.some(t => t.status === 'failed') ? 'alert' : 'status'}
      aria-live={toasts.some(t => t.status === 'failed') ? 'assertive' : 'polite'}
    >
      {toasts.map(t => (
        <div key={t.id} className="pointer-events-auto">
          <TxToastItem toast={t} />
        </div>
      ))}
    </div>
  );
}
