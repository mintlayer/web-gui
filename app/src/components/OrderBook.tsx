"use client";

import { useState, useEffect, useRef } from "react";
import { watchTx } from "@/lib/txWatcher";
import { submitWithToast } from "@/lib/toastStore";
import { CopyButton } from "@/components/CopyButton";
import type { OrderInfo, TokenCurrency } from "@/lib/wallet-rpc";

// Raw shape returned by order_list_all_active (flat, no existing_order_data wrapper)
interface ActiveOrderRaw {
  order_id: string;
  initially_asked: TokenCurrency;
  initially_given: TokenCurrency;
  ask_balance: { atoms: string; decimal: string };
  give_balance: { atoms: string; decimal: string };
  is_own: boolean;
}

function normalizeActiveOrder(o: ActiveOrderRaw): OrderInfo {
  return {
    order_id: o.order_id,
    initially_asked: o.initially_asked,
    initially_given: o.initially_given,
    existing_order_data: {
      ask_balance: o.ask_balance,
      give_balance: o.give_balance,
      creation_timestamp: { timestamp: 0 },
      is_frozen: false,
    },
    is_marked_as_frozen_in_wallet: false,
    is_marked_as_concluded_in_wallet: false,
  };
}

// ── Favourites (shared with TokenSearch) ──────────────────────────────────────

interface FavouriteEntry {
  tokenId: string;
  ticker: string;
}

async function loadFavourites(): Promise<FavouriteEntry[]> {
  try {
    const res = await fetch("/api/prefs");
    const data = await res.json() as { ok: boolean; value?: FavouriteEntry[] };
    return data.ok ? (data.value ?? []) : [];
  } catch {
    return [];
  }
}

function saveFavourites(favs: FavouriteEntry[]): void {
  fetch("/api/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(favs),
  }).catch(() => {});
}

// ── RPC helper ────────────────────────────────────────────────────────────────

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

// ── Error translation ─────────────────────────────────────────────────────────

function friendlyError(err: unknown): string {
  const raw = (err as Error)?.message ?? String(err);
  const lower = raw.toLowerCase();

  if (lower.includes('not enough funds') || lower.includes('coin selection error')) {
    // Extract "got" atoms if present
    const gotMatch = raw.match(/got:\s*Amount\s*\{\s*atoms:\s*(\d+)\s*\}/i);
    const gotAtoms = gotMatch ? BigInt(gotMatch[1]) : null;
    const gotML = gotAtoms !== null
      ? (Number(gotAtoms) / 1e11).toLocaleString(undefined, { maximumFractionDigits: 8 }) + ' ML'
      : null;
    return gotML
      ? `Insufficient funds — your balance (${gotML}) is too low to cover this transaction including fees.`
      : 'Insufficient funds to cover this transaction including fees.';
  }
  if (lower.includes('no wallet') || lower.includes('wallet not open')) {
    window.location.href = '/';
    return '';
  }
  if (lower.includes('cannot reach') || lower.includes('network') || lower.includes('fetch')) {
    return 'Could not reach the wallet daemon. Check that all services are running.';
  }
  if (lower.includes('broadcast') || lower.includes('rejected')) {
    return 'Transaction was rejected by the network. Please try again.';
  }
  if (lower.includes('already exists') || lower.includes('duplicate')) {
    return 'This transaction has already been submitted.';
  }
  if (lower.includes('locked') || lower.includes('private key')) {
    return 'Wallet is locked. Unlock your private keys first.';
  }
  if (lower.includes('no orders available')) {
    return 'No matching orders available to fill.';
  }
  // Strip noisy "Wallet controller error: Wallet error:" prefixes
  return raw
    .replace(/^wallet controller error:\s*/i, '')
    .replace(/^wallet error:\s*/i, '');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function currencyLabel(c: TokenCurrency, tickerMap?: Map<string, string>): string {
  if (c.type === "Coin") return "ML";
  const id = c.content.id;
  return tickerMap?.get(id) ?? (id.slice(0, 10) + "…");
}

function currencyAmount(c: TokenCurrency): string {
  return c.content.amount.decimal;
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString();
}

/** Price in ML per token unit */
function calcPrice(mlDecimal: string, tokenDecimal: string): string {
  const ml = parseFloat(mlDecimal);
  const tok = parseFloat(tokenDecimal);
  if (!tok || !ml) return "—";
  return (ml / tok).toPrecision(6).replace(/\.?0+$/, "");
}

// ── Buy / Sell panel ──────────────────────────────────────────────────────────

function BuySellPanel({
  selectedTokenId,
  ticker,
  pairAsks,
  pairBids,
  mlBalance,
  tokenBalance,
  onCreated,
  onPairRefresh,
}: {
  selectedTokenId: string | null;
  ticker: string;
  pairAsks: OrderInfo[];
  pairBids: OrderInfo[];
  mlBalance: string | null;
  tokenBalance: string | null;
  onCreated: () => void;
  onPairRefresh: () => void;
}) {
  const [side, setSide]     = useState<"buy" | "sell">("buy");
  const [type, setType]     = useState<"limit" | "market">("limit");
  const [tokenId, setTokenId] = useState(""); // manual token ID when no pair selected
  const [amount, setAmount] = useState("");   // token amount
  const [price, setPrice]   = useState("");   // ML per token (limit only)
  const [mlAmount, setMlAmount] = useState(""); // ML to spend (buy market)
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  const effectiveTokenId = selectedTokenId ?? tokenId;
  const effectiveTicker  = selectedTokenId ? ticker : (tokenId ? tokenId.slice(0, 8) + "…" : "TOKEN");

  // Best prices from the loaded pair order book
  const bestAsk = pairAsks[0];
  const bestBid = pairBids[0];

  const bestAskPrice = bestAsk?.existing_order_data
    ? calcPrice(bestAsk.existing_order_data.ask_balance.decimal, bestAsk.existing_order_data.give_balance.decimal)
    : null;
  const bestBidPrice = bestBid?.existing_order_data
    ? calcPrice(bestBid.existing_order_data.give_balance.decimal, bestBid.existing_order_data.ask_balance.decimal)
    : null;

  const totalML = amount && price
    ? (parseFloat(amount) * parseFloat(price)).toPrecision(8).replace(/\.?0+$/, "")
    : "";

  const estTokens = mlAmount && bestAskPrice && bestAskPrice !== "—"
    ? (parseFloat(mlAmount) / parseFloat(bestAskPrice)).toPrecision(6).replace(/\.?0+$/, "")
    : null;

  const estML = amount && bestBidPrice && bestBidPrice !== "—"
    ? (parseFloat(amount) * parseFloat(bestBidPrice)).toPrecision(6).replace(/\.?0+$/, "")
    : null;

  const canSubmit = !loading && !!effectiveTokenId && (
    type === "limit"
      ? (!!amount && !!price && parseFloat(amount) > 0 && parseFloat(price) > 0)
      : side === "buy"
        ? (!!mlAmount && parseFloat(mlAmount) > 0 && !!bestAsk)
        : (!!amount && parseFloat(amount) > 0 && !!bestBid)
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await submitWithToast(async () => {
        if (type === "limit") {
          const total = (parseFloat(amount) * parseFloat(price)).toString();
          // conclude_address is required — fetch a fresh receive address
          const addrRes = await rpc<{ address: string }>("address_new", { account: 0 });
          const res = await rpc<{ tx_id: string }>("order_create", {
            account: 0,
            give: side === "buy"
              ? { type: "Coin", content: { amount: { decimal: total } } }
              : { type: "Token", content: { id: effectiveTokenId, amount: { decimal: amount } } },
            ask: side === "buy"
              ? { type: "Token", content: { id: effectiveTokenId, amount: { decimal: amount } } }
              : { type: "Coin", content: { amount: { decimal: total } } },
            conclude_address: addrRes.address,
            options: {},
          });
          return res.tx_id;
        } else {
          // Market: fill the best available order on the opposite side
          const targetOrder = side === "buy" ? bestAsk : bestBid;
          if (!targetOrder) throw new Error("No orders available to fill");
          // buy market → fill ask → provide ML (what the ask order asks for)
          // sell market → fill bid → provide Token (what the bid order asks for)
          const fillAmt = side === "buy" ? mlAmount : amount;
          const res = await rpc<{ tx_id: string }>("order_fill", {
            account: 0,
            order_id: targetOrder.order_id,
            fill_amount_in_ask_currency: { decimal: fillAmt },
            output_address: null,
            options: {},
          });
          return res.tx_id;
        }
      }, watchTx);

      setAmount(""); setPrice(""); setMlAmount("");
      if (type === "limit") onCreated(); else onPairRefresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  const inputCls = "w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600 disabled:opacity-50";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">

      {/* Side tabs */}
      <div className="flex rounded-lg overflow-hidden border border-gray-700 w-fit">
        <button type="button" onClick={() => setSide("buy")}
          className={`px-6 py-2 text-sm font-semibold transition-colors ${
            side === "buy" ? "bg-green-700 text-white" : "bg-gray-800 text-gray-400 hover:text-gray-200"
          }`}>Buy</button>
        <button type="button" onClick={() => setSide("sell")}
          className={`px-6 py-2 text-sm font-semibold transition-colors ${
            side === "sell" ? "bg-red-700 text-white" : "bg-gray-800 text-gray-400 hover:text-gray-200"
          }`}>Sell</button>
      </div>

      {/* Order type underline tabs */}
      <div className="flex gap-4 border-b border-gray-800 pb-0">
        {(["limit", "market"] as const).map(t => (
          <button key={t} type="button" onClick={() => setType(t)}
            className={`pb-2 text-xs font-medium capitalize transition-colors border-b-2 -mb-px ${
              type === t ? "border-mint-500 text-mint-400" : "border-transparent text-gray-500 hover:text-gray-300"
            }`}>{t}</button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-red-700 bg-red-900/30 p-3 text-red-300 text-sm">{error}</div>
      )}

      {/* ── Balance display ── */}
      {(mlBalance !== null || tokenBalance !== null) && (
        <div className="flex gap-4 rounded-lg bg-gray-800/60 border border-gray-700/50 px-3 py-2 text-xs">
          <span className="text-gray-500">
            ML: <span className={`font-mono ${side === "buy" ? "text-gray-200" : "text-gray-400"}`}>
              {mlBalance ?? "…"}
            </span>
          </span>
          {selectedTokenId && (
            <span className="text-gray-500">
              {ticker}: <span className={`font-mono ${side === "sell" ? "text-gray-200" : "text-gray-400"}`}>
                {tokenBalance ?? "…"}
              </span>
            </span>
          )}
        </div>
      )}

      {/* Manual token ID input when no pair is selected */}
      {!selectedTokenId && (
        <div className="space-y-1.5">
          <label className="block text-xs text-gray-400">Token ID</label>
          <input type="text" placeholder="mmltk1…"
            value={tokenId} onChange={e => setTokenId(e.target.value)}
            className={inputCls} />
        </div>
      )}

      {/* ── Limit order inputs ── */}
      {type === "limit" && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-xs text-gray-400">{effectiveTicker} amount</label>
              <input type="number" min="0" step="any" placeholder="0.0"
                value={amount} onChange={e => setAmount(e.target.value)} disabled={loading}
                className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs text-gray-400">Price (ML/{effectiveTicker})</label>
              <input type="number" min="0" step="any" placeholder="0.0"
                value={price} onChange={e => setPrice(e.target.value)} disabled={loading}
                className={inputCls} />
            </div>
          </div>
          {totalML && (
            <p className="text-xs text-gray-500">
              Total ML: <span className="font-mono text-gray-300">{totalML}</span>
            </p>
          )}
        </div>
      )}

      {/* ── Market buy inputs ── */}
      {type === "market" && side === "buy" && (
        <div className="space-y-3">
          {bestAskPrice
            ? <p className="text-xs text-gray-500">Best ask: <span className="font-mono text-green-400">{bestAskPrice} ML/{effectiveTicker}</span></p>
            : selectedTokenId && <p className="text-xs text-amber-400">No asks available — load the order book first.</p>
          }
          <div className="space-y-1.5">
            <label className="block text-xs text-gray-400">ML to spend</label>
            <input type="number" min="0" step="any" placeholder="0.0"
              value={mlAmount} onChange={e => setMlAmount(e.target.value)} disabled={loading}
              className={inputCls} />
          </div>
          {estTokens && (
            <p className="text-xs text-gray-500">
              Est. receive: <span className="font-mono text-gray-300">{estTokens} {effectiveTicker}</span>
            </p>
          )}
        </div>
      )}

      {/* ── Market sell inputs ── */}
      {type === "market" && side === "sell" && (
        <div className="space-y-3">
          {bestBidPrice
            ? <p className="text-xs text-gray-500">Best bid: <span className="font-mono text-red-400">{bestBidPrice} ML/{effectiveTicker}</span></p>
            : selectedTokenId && <p className="text-xs text-amber-400">No bids available — load the order book first.</p>
          }
          <div className="space-y-1.5">
            <label className="block text-xs text-gray-400">{effectiveTicker} to sell</label>
            <input type="number" min="0" step="any" placeholder="0.0"
              value={amount} onChange={e => setAmount(e.target.value)} disabled={loading}
              className={inputCls} />
          </div>
          {estML && (
            <p className="text-xs text-gray-500">
              Est. receive: <span className="font-mono text-gray-300">{estML} ML</span>
            </p>
          )}
        </div>
      )}

      <button type="submit" disabled={!canSubmit}
        className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50 flex items-center justify-center gap-2 ${
          side === "buy" ? "bg-green-700 hover:bg-green-600" : "bg-red-700 hover:bg-red-600"
        }`}>
        {loading && (
          <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
        {loading ? "Submitting…" : `${side === "buy" ? "Buy" : "Sell"} ${type === "limit" ? "Limit" : "Market"}`}
      </button>
    </form>
  );
}

// ── Fill order form ───────────────────────────────────────────────────────────

// ── My orders ─────────────────────────────────────────────────────────────────

function MyOrderRow({ order, onAction, tickerMap }: { order: OrderInfo; onAction: () => void; tickerMap: Map<string, string> }) {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const run = async (method: string, extraParams: Record<string, unknown> = {}) => {
    setLoading(true);
    setError(null);
    try {
      await submitWithToast(
        async () => {
          const res = await rpc<{ tx_id: string }>(method, {
            account: 0,
            order_id: order.order_id,
            options: {},
            ...extraParams,
          });
          return res.tx_id;
        },
        watchTx,
      );
      onAction();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  const data = order.existing_order_data;
  const isConcluded = order.is_marked_as_concluded_in_wallet || !data;
  const isFrozen    = data?.is_frozen || order.is_marked_as_frozen_in_wallet;

  return (
    <div className="rounded-xl bg-gray-900 border border-gray-800 p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs text-gray-500 mb-0.5">Order ID</p>
          <span className="inline-flex items-center gap-1 flex-wrap">
            <span className="font-mono text-xs text-mint-400 break-all">{order.order_id}</span>
            <CopyButton value={order.order_id} title="Copy order ID" />
          </span>
        </div>
        <div className="flex gap-2 shrink-0">
          {!isConcluded && !isFrozen && (
            <button onClick={() => run("order_freeze")} disabled={loading}
              className="rounded-lg bg-gray-700 hover:bg-gray-600 border border-gray-600 px-3 py-1.5 text-xs
                         font-medium text-gray-300 transition-colors disabled:opacity-40">
              Freeze
            </button>
          )}
          {!isConcluded && (
            <button onClick={() => run("order_conclude")} disabled={loading}
              className="rounded-lg bg-red-900/40 hover:bg-red-800/60 border border-red-800 px-3 py-1.5 text-xs
                         font-medium text-red-300 transition-colors disabled:opacity-40">
              {loading ? "…" : "Conclude"}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Give</p>
          <p className="font-mono text-gray-200">
            {currencyAmount(order.initially_given)}
            <span className="text-gray-500 text-xs ml-1">{currencyLabel(order.initially_given, tickerMap)}</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Ask</p>
          <p className="font-mono text-gray-200">
            {currencyAmount(order.initially_asked)}
            <span className="text-gray-500 text-xs ml-1">{currencyLabel(order.initially_asked, tickerMap)}</span>
          </p>
        </div>
        {data && (
          <>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Remaining give</p>
              <p className="font-mono text-gray-200">
                {data.give_balance.decimal}
                <span className="text-gray-500 text-xs ml-1">{currencyLabel(order.initially_given, tickerMap)}</span>
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Remaining ask</p>
              <p className="font-mono text-gray-200">
                {data.ask_balance.decimal}
                <span className="text-gray-500 text-xs ml-1">{currencyLabel(order.initially_asked, tickerMap)}</span>
              </p>
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        {isConcluded && <span className="text-xs text-gray-600">Concluded</span>}
        {isFrozen && <span className="text-xs bg-blue-900/40 text-blue-300 border border-blue-800 rounded px-1.5 py-0.5">frozen</span>}
        {data && !isConcluded && (
          <span className="text-xs text-gray-600">Created {formatTimestamp(data.creation_timestamp.timestamp)}</span>
        )}
      </div>

      {error && <p className="text-xs text-red-400 break-all">{error}</p>}
    </div>
  );
}

// ── Pair order book row ───────────────────────────────────────────────────────

/**
 * A single row in the pair order book.
 *
 * `side === "ask"`: order gives Token, asks ML  → user provides ML to fill
 * `side === "bid"`: order gives ML, asks Token  → user provides Token to fill
 */
function PairBookRow({
  order,
  side,
  ticker,
  onFilled,
}: {
  order: OrderInfo;
  side: "ask" | "bid";
  ticker: string;
  onFilled: () => void;
}) {
  const [fillAmount, setFillAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data = order.existing_order_data;
  if (!data || data.is_frozen || order.is_marked_as_concluded_in_wallet) return null;

  // For asks (give Token → ask ML): token qty = give_balance, ML qty = ask_balance
  // For bids (give ML → ask Token): ML qty = give_balance, token qty = ask_balance
  const tokenQty  = side === "ask" ? data.give_balance.decimal : data.ask_balance.decimal;
  const mlQty     = side === "ask" ? data.ask_balance.decimal  : data.give_balance.decimal;
  const price     = calcPrice(mlQty, tokenQty);
  const fillLabel = side === "ask" ? "ML" : ticker;

  const handleFill = async () => {
    setLoading(true);
    setError(null);
    try {
      await submitWithToast(
        async () => {
          const res = await rpc<{ tx_id: string }>("order_fill", {
            account: 0,
            order_id: order.order_id,
            fill_amount_in_ask_currency: { decimal: fillAmount },
            output_address: null,
            options: {},
          });
          return res.tx_id;
        },
        watchTx,
      );
      setFillAmount("");
      onFilled();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <tr className="hover:bg-gray-800/40 transition-colors">
      <td className="px-3 py-2.5 font-mono text-sm text-gray-200">{price}</td>
      <td className="px-3 py-2.5 font-mono text-sm text-gray-300">{tokenQty}</td>
      <td className="px-3 py-2.5 font-mono text-sm text-gray-400">{mlQty}</td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <input
            type="number" min="0" step="any" placeholder={fillLabel}
            value={fillAmount} onChange={e => setFillAmount(e.target.value)}
            disabled={loading}
            className="w-24 rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600
                       px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-mint-600 disabled:opacity-50"
          />
          <button
            onClick={handleFill} disabled={loading || !fillAmount}
            className="rounded-lg bg-mint-700 hover:bg-mint-600 px-2.5 py-1 text-xs font-medium text-white
                       transition-colors disabled:opacity-40"
          >
            {loading ? "…" : "Fill"}
          </button>
        </div>
        {error && <p className="text-xs text-red-400 mt-0.5 break-all">{error}</p>}
      </td>
    </tr>
  );
}

// ── Pair order book panel ─────────────────────────────────────────────────────

function PairBookPanel({
  title,
  orders,
  side,
  ticker,
  colorClass,
  onFilled,
}: {
  title: string;
  orders: OrderInfo[];
  side: "ask" | "bid";
  ticker: string;
  colorClass: string;
  onFilled: () => void;
}) {
  return (
    <div className="rounded-xl border border-gray-800 overflow-x-auto">
      <div className={`px-4 py-2 border-b border-gray-800 text-xs font-semibold uppercase tracking-wider ${colorClass}`}>
        {title}
      </div>
      {orders.length === 0 ? (
        <p className="px-4 py-4 text-sm text-gray-500">No orders.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
              <th className="px-3 py-2">Price (ML/{ticker})</th>
              <th className="px-3 py-2">{ticker} amount</th>
              <th className="px-3 py-2">ML total</th>
              <th className="px-3 py-2">Fill</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/60">
            {orders.map(o => (
              <PairBookRow key={o.order_id} order={o} side={side} ticker={ticker} onFilled={onFilled} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  initialOwnOrders: OrderInfo[];
  balanceTokens?: { tokenId: string; ticker: string }[];
  initialTokenId?: string | null;
}

export default function OrderBook({ initialOwnOrders, balanceTokens = [], initialTokenId = null }: Props) {
  const [ownOrders, setOwnOrders] = useState<OrderInfo[]>(initialOwnOrders);

  // ── Pair selector state ──
  const [favourites, setFavourites] = useState<FavouriteEntry[]>([]);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [pairAsks, setPairAsks] = useState<OrderInfo[]>([]); // give Token, ask ML
  const [pairBids, setPairBids] = useState<OrderInfo[]>([]); // give ML, ask Token
  const [pairLoading, setPairLoading] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [mlBalance, setMlBalance] = useState<string | null>(null);
  const [tokenBalance, setTokenBalance] = useState<string | null>(null);
  // Incremented each time a new pair is selected; loadPairOrders checks it before
  // writing state so stale in-flight responses are silently discarded.
  const loadSeqRef = useRef(0);

  // Extra tickers resolved from order token IDs not already in favourites
  const resolvedTokenIds = useRef(new Set<string>());
  const [extraTickers, setExtraTickers] = useState<Map<string, string>>(new Map());

  // My Orders filter state
  const [filterText, setFilterText] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'concluded' | 'frozen'>('all');
  const [filterDir, setFilterDir] = useState<'all' | 'buy' | 'sell'>('all');

  useEffect(() => {
    (async () => {
      // Load from server-side prefs (same store as Token Management page)
      let favs = await loadFavourites();

      // Auto-star any tokens that have a balance — merge into favourites
      if (balanceTokens.length > 0) {
        const existingIds = new Set(favs.map(f => f.tokenId));
        const newEntries = balanceTokens.filter(t => !existingIds.has(t.tokenId));
        if (newEntries.length > 0) {
          favs = [...newEntries, ...favs];
          saveFavourites(favs);
        }
      }

      // Resolve types and tickers for all favourites.
      // NFTs are filtered out — the order book only supports fungible token pairs.
      // node_get_tokens_info does not preserve input order, so call one at a time.
      const allIds = favs.map(f => f.tokenId);
      if (allIds.length === 0) { setFavourites(favs); return; }

      try {
        const results = await Promise.all(
          allIds.map(id =>
            rpc<[{ type: string; content: { token_ticker?: { text: string | null }; metadata?: { ticker?: { text: string | null }; name?: { text: string | null } } } } | null]>(
              "node_get_tokens_info", { token_ids: [id] }
            ).then(([info]) => ({ id, info: info ?? null }))
            .catch(() => ({ id, info: null as null }))
          )
        );
        const tickerUpdates = new Map<string, string>();
        const nftIds = new Set<string>();
        results.forEach(({ id, info }) => {
          if (!info) return;
          if (info.type !== "FungibleToken") { nftIds.add(id); return; }
          const ticker = info.content.token_ticker?.text ?? null;
          if (ticker) tickerUpdates.set(id, ticker);
        });
        // Strip NFTs and update tickers; persist cleaned list to server prefs
        const fungibleFavs = favs
          .filter(f => !nftIds.has(f.tokenId))
          .map(f => tickerUpdates.has(f.tokenId) ? { ...f, ticker: tickerUpdates.get(f.tokenId)! } : f);
        // If a specific token was requested (e.g. from /balances Buy/Sell), ensure
        // it's in the list and select it — add it to favourites if not already there.
        let finalFavs = fungibleFavs;
        if (initialTokenId && !fungibleFavs.some(f => f.tokenId === initialTokenId)) {
          try {
            const [info] = await rpc<[{ type: string; content: { token_ticker?: { text: string | null } } } | null]>(
              "node_get_tokens_info", { token_ids: [initialTokenId] }
            );
            if (info?.type === "FungibleToken") {
              const ticker = info.content.token_ticker?.text ?? initialTokenId.slice(0, 8) + "…";
              finalFavs = [{ tokenId: initialTokenId, ticker }, ...fungibleFavs];
            }
          } catch { /* leave finalFavs as-is */ }
        }

        saveFavourites(finalFavs);
        setFavourites(finalFavs);
        // Priority: 1) requested token, 2) token with balance, 3) first fungible fav
        const autoSelect = initialTokenId ?? balanceTokens[0]?.tokenId ?? finalFavs[0]?.tokenId ?? null;
        if (autoSelect) handlePairChange(autoSelect);
      } catch {
        setFavourites(favs);
        const autoSelect = initialTokenId ?? balanceTokens[0]?.tokenId ?? favs[0]?.tokenId ?? null;
        if (autoSelect) handlePairChange(autoSelect);
      }
    })();
  }, []);

  // Resolve tickers for any token IDs appearing in own orders that aren't in favourites
  useEffect(() => {
    const tokenIds = new Set<string>();
    for (const o of ownOrders) {
      if (o.initially_given.type === 'Token') tokenIds.add(o.initially_given.content.id);
      if (o.initially_asked.type === 'Token') tokenIds.add(o.initially_asked.content.id);
    }
    if (tokenIds.size === 0) return;

    const favIds = new Set(favourites.map(f => f.tokenId));
    const unknownIds = [...tokenIds].filter(
      id => !favIds.has(id) && !resolvedTokenIds.current.has(id)
    );
    if (unknownIds.length === 0) return;

    unknownIds.forEach(id => resolvedTokenIds.current.add(id));

    Promise.all(
      unknownIds.map(id =>
        rpc<[{ type: string; content: { token_ticker?: { text: string | null }; metadata?: { ticker?: { text: string | null }; name?: { text: string | null } } } } | null]>(
          'node_get_tokens_info', { token_ids: [id] }
        ).then(([info]) => ({ id, info: info ?? null }))
        .catch(() => ({ id, info: null as null }))
      )
    ).then(results => {
      const newMap = new Map<string, string>();
      results.forEach(({ id, info }) => {
        if (!info) return;
        const ticker = info.type === 'FungibleToken'
          ? (info.content.token_ticker?.text ?? null)
          : (info.content.metadata?.ticker?.text ?? info.content.metadata?.name?.text ?? null);
        if (ticker) newMap.set(id, ticker);
      });
      if (newMap.size > 0) setExtraTickers(prev => new Map([...prev, ...newMap]));
    }).catch(() => {});
  }, [ownOrders, favourites]);

  const rawTicker = favourites.find(f => f.tokenId === selectedTokenId)?.ticker ?? "???";
  const selectedTicker = rawTicker === "???" ? (selectedTokenId?.slice(0, 12) + "…") : rawTicker;

  // Combined ticker map for My Orders: favourites + any extra tickers resolved for order tokens
  const tickerMap = new Map<string, string>([
    ...favourites
      .filter(f => f.ticker && f.ticker !== '???')
      .map(f => [f.tokenId, f.ticker] as [string, string]),
    ...extraTickers,
  ]);

  const loadPairOrders = async (tokenId: string) => {
    const seq = ++loadSeqRef.current;
    setPairLoading(true);
    setPairError(null);
    try {
      const tokenCurrency = { type: "Token", content: tokenId };
      const [asksRaw, bidsRaw, balance] = await Promise.all([
        // Asks: give Token, ask ML — sorted by price ascending (cheapest ask first)
        rpc<ActiveOrderRaw[]>("order_list_all_active", {
          account: 0,
          ask_currency: { type: "Coin" },
          give_currency: tokenCurrency,
        }),
        // Bids: give ML, ask Token — sorted by price descending (highest bid first)
        rpc<ActiveOrderRaw[]>("order_list_all_active", {
          account: 0,
          ask_currency: tokenCurrency,
          give_currency: { type: "Coin" },
        }),
        rpc<{ coins: { decimal: string }; tokens: Record<string, { decimal: string }> }>(
          "account_balance", { account: 0, utxo_states: ["Confirmed"], with_locked: "Unlocked" }
        ),
      ]);

      // Discard if a newer request was started while we were awaiting
      if (seq !== loadSeqRef.current) return;

      setMlBalance(balance.coins.decimal);
      setTokenBalance(balance.tokens[tokenId]?.decimal ?? "0");

      const asks = asksRaw.map(normalizeActiveOrder);
      const bids = bidsRaw.map(normalizeActiveOrder);

      // Sort asks ascending by price (ML/token), bids descending
      const priceOf = (o: OrderInfo, side: "ask" | "bid") => {
        const d = o.existing_order_data;
        if (!d) return 0;
        const tok = parseFloat(side === "ask" ? d.give_balance.decimal : d.ask_balance.decimal);
        const ml  = parseFloat(side === "ask" ? d.ask_balance.decimal  : d.give_balance.decimal);
        return tok ? ml / tok : 0;
      };

      setPairAsks(asks.sort((a, b) => priceOf(a, "ask") - priceOf(b, "ask")));
      setPairBids(bids.sort((a, b) => priceOf(b, "bid") - priceOf(a, "bid")));
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setPairError(friendlyError(err));
    } finally {
      if (seq === loadSeqRef.current) setPairLoading(false);
    }
  };

  const handlePairChange = (tokenId: string) => {
    const id = tokenId || null;
    setSelectedTokenId(id);
    setPairAsks([]);
    setPairBids([]);
    if (id) loadPairOrders(id);
  };

  const refreshOwn = async () => {
    try {
      const orders = await rpc<OrderInfo[]>("order_list_own", { account: 0 });
      setOwnOrders(orders);
    } catch { /* ignore */ }
  };

  const activeOwn = ownOrders.filter(o =>
    !o.is_marked_as_concluded_in_wallet && o.existing_order_data && !o.existing_order_data.is_frozen
  );

  const filteredOrders = ownOrders.filter(o => {
    const data = o.existing_order_data;
    const isConcluded = o.is_marked_as_concluded_in_wallet || !data;
    const isFrozen    = data?.is_frozen || o.is_marked_as_frozen_in_wallet;
    const isActive    = !isConcluded && !isFrozen;

    if (filterStatus === 'active'    && !isActive)    return false;
    if (filterStatus === 'concluded' && !isConcluded) return false;
    if (filterStatus === 'frozen'    && !isFrozen)    return false;

    const isBuy = o.initially_given.type === 'Coin'; // gave ML → buying token
    if (filterDir === 'buy'  && !isBuy) return false;
    if (filterDir === 'sell' &&  isBuy) return false;

    if (filterText) {
      const q = filterText.toLowerCase();
      const giveLabel = currencyLabel(o.initially_given, tickerMap).toLowerCase();
      const askLabel  = currencyLabel(o.initially_asked, tickerMap).toLowerCase();
      const giveId = o.initially_given.type === 'Token' ? o.initially_given.content.id.toLowerCase() : '';
      const askId  = o.initially_asked.type === 'Token' ? o.initially_asked.content.id.toLowerCase() : '';
      if (!o.order_id.toLowerCase().includes(q) &&
          !giveLabel.includes(q) && !askLabel.includes(q) &&
          !giveId.includes(q) && !askId.includes(q)) return false;
    }

    return true;
  });

  return (
    <div className="space-y-8">

      {/* ── Pair selector ── */}
      <section>
        <h2 className="text-base font-semibold text-gray-200 mb-3">Order Book</h2>
        <div className="rounded-xl bg-gray-900 border border-gray-800 p-4">
          {favourites.length === 0 ? (
            <div className="rounded-lg border border-gray-700 bg-gray-800/50 px-4 py-5 text-sm text-gray-400">
              <p className="font-medium text-gray-300 mb-1">No tokens in your watchlist</p>
              <p>
                To trade, you need at least one token added to your watchlist.{" "}
                Go to{" "}
                <a href="/token-management" className="text-mint-400 hover:text-mint-300 underline">
                  Token Management
                </a>
                , search for a token, and pin it — then come back here to trade.
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-3 flex-wrap">
              <label className="text-sm text-gray-400 shrink-0">Trading pair:</label>
              <select
                value={selectedTokenId ?? ""}
                onChange={e => handlePairChange(e.target.value)}
                className="rounded-lg bg-gray-800 border border-gray-700 text-gray-100 px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-mint-600"
              >
                <option value="">— Select pair —</option>
                {favourites.map(f => (
                  <option key={f.tokenId} value={f.tokenId}>
                    ML / {f.ticker === "???" ? f.tokenId.slice(0, 12) + "…" : f.ticker}
                  </option>
                ))}
              </select>
              {selectedTokenId && (
                <button
                  onClick={() => loadPairOrders(selectedTokenId)}
                  disabled={pairLoading}
                  className="rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 px-3 py-2 text-xs
                             font-medium text-gray-300 transition-colors disabled:opacity-50"
                >
                  {pairLoading ? "Loading…" : "Refresh"}
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── Order book tables ── */}
        {selectedTokenId && (
          <div className="mt-4 space-y-4">
            {pairError && (
              <div className="rounded-lg border border-red-700 bg-red-900/30 p-3 text-red-300 text-sm">{pairError}</div>
            )}
            {pairLoading && (
              <p className="text-sm text-gray-500">Loading orders…</p>
            )}
            {!pairLoading && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <PairBookPanel
                  title={`Asks — sell ${selectedTicker} for ML`}
                  orders={pairAsks}
                  side="ask"
                  ticker={selectedTicker}
                  colorClass="text-red-400"
                  onFilled={() => loadPairOrders(selectedTokenId)}
                />
                <PairBookPanel
                  title={`Bids — buy ${selectedTicker} with ML`}
                  orders={pairBids}
                  side="bid"
                  ticker={selectedTicker}
                  colorClass="text-green-400"
                  onFilled={() => loadPairOrders(selectedTokenId)}
                />
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Buy / Sell ── */}
      <section>
        <h2 className="text-base font-semibold text-gray-200 mb-3">Place Order</h2>
        <div className="rounded-xl bg-gray-900 border border-gray-800 p-6">
          <BuySellPanel
            selectedTokenId={selectedTokenId}
            ticker={selectedTicker}
            pairAsks={pairAsks}
            pairBids={pairBids}
            mlBalance={mlBalance}
            tokenBalance={tokenBalance}
            onCreated={refreshOwn}
            onPairRefresh={() => selectedTokenId && loadPairOrders(selectedTokenId)}
          />
        </div>
      </section>

      {/* ── My orders ── */}
      <section>
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <h2 className="text-base font-semibold text-gray-200">
            My Orders
            {activeOwn.length > 0 && (
              <span className="ml-2 text-mint-400 font-mono text-sm">{activeOwn.length} active</span>
            )}
          </h2>
          <button
            onClick={refreshOwn}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Refresh
          </button>
        </div>

        {ownOrders.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3 items-center">
            {/* Text search */}
            <input
              type="text"
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
              placeholder="Search by ticker or order ID…"
              className="rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600
                         px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-mint-600 w-56"
            />
            {/* Status filter */}
            <div className="flex rounded-lg overflow-hidden border border-gray-700 text-xs">
              {(['all', 'active', 'concluded', 'frozen'] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFilterStatus(s)}
                  className={`px-2.5 py-1.5 font-medium transition-colors capitalize ${
                    filterStatus === s
                      ? 'bg-gray-600 text-gray-100'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            {/* Direction filter */}
            <div className="flex rounded-lg overflow-hidden border border-gray-700 text-xs">
              {(['all', 'buy', 'sell'] as const).map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setFilterDir(d)}
                  className={`px-2.5 py-1.5 font-medium transition-colors capitalize ${
                    filterDir === d
                      ? 'bg-gray-600 text-gray-100'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}

        {ownOrders.length === 0 ? (
          <p className="text-sm text-gray-500">No orders yet.</p>
        ) : filteredOrders.length === 0 ? (
          <p className="text-sm text-gray-500">No orders match the current filter.</p>
        ) : (
          <div className="space-y-3">
            {filteredOrders.map(o => (
              <MyOrderRow key={o.order_id} order={o} onAction={refreshOwn} tickerMap={tickerMap} />
            ))}
          </div>
        )}
      </section>

    </div>
  );
}
