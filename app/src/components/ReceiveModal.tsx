"use client";

import { useState, useEffect, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; address: string }
  | { status: "error"; message: string };

async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const data = await res.json() as { ok: boolean; result?: T; error?: { message: string } };
  if (!data.ok) throw new Error(data.error?.message ?? "RPC error");
  return data.result as T;
}

export default function ReceiveModal() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ status: "idle" });
  const [copied, setCopied] = useState(false);

  const loadAddress = useCallback(async () => {
    setState({ status: "loading" });
    try {
      // Fetch all receive addresses
      const addresses = await rpc<Array<{ address: string; used: boolean; purpose: string }>>(
        "address_show",
        { account: 0, include_change_addresses: false }
      );

      // Find first unused receive address
      const unused = addresses.find(a => a.purpose === "Receive" && !a.used);

      if (unused) {
        setState({ status: "ready", address: unused.address });
      } else {
        // All used - generate a fresh one
        const result = await rpc<{ address: string }>("address_new", { account: 0 });
        setState({ status: "ready", address: result.address });
      }
    } catch (err) {
      setState({ status: "error", message: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    if (open && state.status === "idle") {
      loadAddress();
    }
    if (!open) {
      setState({ status: "idle" });
      setCopied(false);
    }
  }, [open]);

  const copy = async (address: string) => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-gray-800 hover:bg-gray-700 px-4 py-2 text-sm text-gray-200 transition-colors"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="8 17 12 21 16 17" />
          <line x1="12" y1="3" x2="12" y2="21" />
        </svg>
        Receive
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="relative bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-gray-100">Receive</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-gray-500 hover:text-gray-300 transition-colors"
                aria-label="Close"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {state.status === "loading" && (
              <div className="flex flex-col items-center py-10 gap-3 text-gray-400 text-sm">
                <svg className="animate-spin w-6 h-6 text-mint-400" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.3" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                Loading address…
              </div>
            )}

            {state.status === "error" && (
              <div className="rounded-lg border border-red-700 bg-red-900/30 p-4 text-red-300 text-sm">
                <strong>Error:</strong> {state.message}
                <button onClick={loadAddress} className="block mt-2 text-xs underline hover:text-red-100">
                  Try again
                </button>
              </div>
            )}

            {state.status === "ready" && (
              <div className="flex flex-col items-center gap-4">
                <p className="text-xs text-gray-500 text-center">
                  Share this address to receive ML or any Mintlayer token.
                </p>

                {/* QR code */}
                <div className="bg-white rounded-xl p-3">
                  <QRCodeSVG
                    value={state.address}
                    size={200}
                    level="M"
                    includeMargin={false}
                  />
                </div>

                {/* Address */}
                <div className="w-full">
                  <p className="font-mono text-xs text-gray-300 break-all bg-gray-800 rounded-lg px-3 py-2 text-center leading-relaxed">
                    {state.address}
                  </p>
                </div>

                {/* Copy button */}
                <button
                  onClick={() => copy(state.address)}
                  className={`w-full rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                    copied
                      ? "bg-mint-700 text-white"
                      : "bg-gray-700 hover:bg-gray-600 text-gray-100"
                  }`}
                >
                  {copied ? "Copied!" : "Copy Address"}
                </button>

                {/* New address */}
                <button
                  onClick={loadAddress}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors underline"
                >
                  Generate new address
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
