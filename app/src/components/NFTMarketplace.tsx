"use client";

import { useState, useEffect } from "react";
import { watchTx } from "@/lib/txWatcher";
import { submitWithToast } from "@/lib/toastStore";
import { hexToText } from "@/lib/token-utils";
import type { TokenCurrency, OrderInfo } from "@/lib/wallet-rpc";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OwnedNFT {
  tokenId: string;
  name: string;
  ticker: string;
  iconUri: string | null;
}

// Raw shape returned by order_list_all_active (flat, no existing_order_data wrapper)
interface ActiveOrderRaw {
  order_id: string;
  initially_asked: TokenCurrency;
  initially_given: TokenCurrency;
  ask_balance: { atoms: string; decimal: string };
  give_balance: { atoms: string; decimal: string };
  is_own: boolean;
}

interface NFTListing {
  orderId: string;
  nftId: string;
  name: string;
  ticker: string;
  iconUri: string | null; // already resolved to HTTP URL
  priceML: string;        // decimal string
  isOwn: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveUri(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + raw.slice(7);
  return raw;
}

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

function friendlyError(err: unknown): string {
  const raw = (err as Error)?.message ?? String(err);
  const lower = raw.toLowerCase();
  if (lower.includes("not enough funds") || lower.includes("coin selection error")) {
    return "Insufficient funds to cover this transaction including fees.";
  }
  if (lower.includes("no wallet") || lower.includes("wallet not open")) {
    window.location.href = "/";
    return "";
  }
  if (lower.includes("cannot reach") || lower.includes("network") || lower.includes("fetch")) {
    return "Could not reach the wallet daemon. Check that all services are running.";
  }
  if (lower.includes("broadcast") || lower.includes("rejected")) {
    return "Transaction was rejected by the network. Please try again.";
  }
  if (lower.includes("locked") || lower.includes("private key")) {
    return "Wallet is locked. Unlock your private keys first.";
  }
  return raw
    .replace(/^wallet controller error:\s*/i, "")
    .replace(/^wallet error:\s*/i, "");
}

// ── Sell modal ────────────────────────────────────────────────────────────────

function SellNFTModal({
  nft,
  onClose,
  onDone,
}: {
  nft: OwnedNFT;
  onClose: () => void;
  onDone: () => void;
}) {
  const [listPrice, setListPrice] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolvedIcon = resolveUri(nft.iconUri);
  const [iconErrored, setIconErrored] = useState(false);

  const canSubmit = !loading && !!listPrice && parseFloat(listPrice) > 0;

  async function handleList(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await submitWithToast(async () => {
        const addrRes = await rpc<{ address: string }>("address_new", { account: 0 });
        const res = await rpc<{ tx_id: string }>("order_create", {
          account: 0,
          give: { type: "Token", content: { id: nft.tokenId, amount: { atoms: "1" } } },
          ask:  { type: "Coin",  content: { amount: { decimal: listPrice } } },
          conclude_address: addrRes.address,
          options: {},
        });
        return res.tx_id;
      }, watchTx);
      onDone();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  // Close on backdrop click
  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={handleBackdrop}
    >
      <div className="relative w-full max-w-sm rounded-2xl bg-gray-900 border border-gray-700 shadow-2xl p-6 flex flex-col gap-5">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-500 hover:text-gray-200 transition-colors text-xl leading-none"
          aria-label="Close"
        >
          ✕
        </button>

        <h2 className="text-base font-semibold text-gray-100">List NFT for Sale</h2>

        {/* NFT preview */}
        <div className="flex gap-4 items-center">
          <div className="w-20 h-20 flex-shrink-0 rounded-xl overflow-hidden bg-gray-800 border border-gray-700 flex items-center justify-center">
            {resolvedIcon && !iconErrored ? (
              <img
                src={resolvedIcon}
                alt={nft.name}
                onError={() => setIconErrored(true)}
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="text-3xl text-gray-600 select-none">?</span>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-100 truncate">{nft.name}</p>
            {nft.ticker && (
              <span className="inline-block rounded bg-gray-800 border border-gray-700 px-1.5 py-0.5 text-xs font-mono text-gray-400 mt-0.5">
                {nft.ticker}
              </span>
            )}
            <p className="text-xs text-gray-600 font-mono mt-1 truncate">{nft.tokenId.slice(0, 20)}…</p>
          </div>
        </div>

        {/* Price form */}
        <form onSubmit={handleList} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1.5 font-medium uppercase tracking-wide">
              Price (ML)
            </label>
            <input
              type="number"
              min="0"
              step="any"
              placeholder="e.g. 100"
              value={listPrice}
              onChange={e => setListPrice(e.target.value)}
              disabled={loading}
              autoFocus
              className="w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600 disabled:opacity-50"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-700 bg-red-900/30 p-3 text-red-300 text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-300 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="flex-1 rounded-lg bg-mint-700 hover:bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-50"
            >
              {loading ? "Listing…" : "List for Sale"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function NFTImage({ uri, name }: { uri: string | null; name: string }) {
  const [errored, setErrored] = useState(false);
  if (!uri || errored) {
    return (
      <div className="w-full aspect-square rounded-lg bg-gray-800 border border-gray-700 flex items-center justify-center">
        <span className="text-4xl text-gray-600 select-none">?</span>
      </div>
    );
  }
  return (
    <img
      src={uri}
      alt={name}
      onError={() => setErrored(true)}
      className="w-full aspect-square object-cover rounded-lg bg-gray-800 border border-gray-700"
    />
  );
}

function BuyButton({ listing, onDone }: { listing: NFTListing; onDone: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBuy = async () => {
    setLoading(true);
    setError(null);
    try {
      await submitWithToast(async () => {
        const res = await rpc<{ tx_id: string }>("order_fill", {
          account: 0,
          order_id: listing.orderId,
          fill_amount_in_ask_currency: { decimal: listing.priceML },
          output_address: null,
          options: {},
        });
        return res.tx_id;
      }, watchTx);
      onDone();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        onClick={handleBuy}
        disabled={loading}
        className="w-full rounded-lg bg-mint-700 hover:bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-50"
      >
        {loading ? "Buying…" : `Buy for ${listing.priceML} ML`}
      </button>
      {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
    </div>
  );
}

function CancelButton({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCancel = async () => {
    setLoading(true);
    setError(null);
    try {
      await submitWithToast(async () => {
        const res = await rpc<{ tx_id: string }>("order_conclude", {
          account: 0,
          order_id: orderId,
          options: {},
        });
        return res.tx_id;
      }, watchTx);
      onDone();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        onClick={handleCancel}
        disabled={loading}
        className="w-full rounded-lg bg-red-900/40 hover:bg-red-800/60 border border-red-800 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors disabled:opacity-40"
      >
        {loading ? "Cancelling…" : "Cancel listing"}
      </button>
      {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
    </div>
  );
}

function NFTCard({
  listing,
  showBuy,
  showCancel,
  onAction,
}: {
  listing: NFTListing;
  showBuy: boolean;
  showCancel: boolean;
  onAction: () => void;
}) {
  return (
    <div className="rounded-xl bg-gray-900 border border-gray-800 p-4 flex flex-col gap-3">
      <NFTImage uri={listing.iconUri} name={listing.name} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-sm font-semibold text-gray-100 truncate">{listing.name}</span>
          {listing.ticker && (
            <span className="rounded bg-gray-800 border border-gray-700 px-1.5 py-0.5 text-xs font-mono text-gray-400">
              {listing.ticker}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 font-mono truncate">{listing.nftId.slice(0, 16)}…</p>
      </div>
      <div className="text-sm font-semibold text-mint-400">{listing.priceML} ML</div>
      {showBuy && <BuyButton listing={listing} onDone={onAction} />}
      {showCancel && <CancelButton orderId={listing.orderId} onDone={onAction} />}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function NFTMarketplace({
  ownedNFTs,
  initialNFTId = null,
}: {
  ownedNFTs: OwnedNFT[];
  initialNFTId?: string | null;
}) {
  const [tab, setTab] = useState<"browse" | "sell">(initialNFTId ? "sell" : "browse");

  // Browse state
  const [listings, setListings] = useState<NFTListing[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  // Sell modal state
  const [sellModalNFT, setSellModalNFT] = useState<OwnedNFT | null>(null);

  // My listings state
  const [myListings, setMyListings] = useState<NFTListing[]>([]);
  const [myListingsLoading, setMyListingsLoading] = useState(false);

  useEffect(() => { loadListings(); }, []);
  useEffect(() => { if (tab === "sell") loadMyListings(); }, [tab]);
  // Pre-open sell modal when arriving from /balances Sell button
  useEffect(() => {
    if (!initialNFTId) return;
    const nft = ownedNFTs.find(n => n.tokenId === initialNFTId);
    if (nft) setSellModalNFT(nft);
  }, []);
  // Close modal with Escape key
  useEffect(() => {
    if (!sellModalNFT) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setSellModalNFT(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sellModalNFT]);

  // ── Data loaders ────────────────────────────────────────────────────────────

  async function loadListings() {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const raw = await rpc<ActiveOrderRaw[]>("order_list_all_active", {
        account: 0,
        ask_currency: { type: "Coin" },
        give_currency: null,
      });

      // Filter: give=Token with give_balance of exactly 1 atom (NFT, fully unfilled)
      const nftCandidates = raw.filter(
        o =>
          o.initially_given.type === "Token" &&
          o.initially_given.content.amount.atoms === "1" &&
          o.give_balance.atoms === "1",
      );

      if (nftCandidates.length === 0) {
        setListings([]);
        return;
      }

      const uniqueIds = [
        ...new Set(
          nftCandidates.map(
            o => (o.initially_given as { type: "Token"; content: { id: string } }).content.id,
          ),
        ),
      ];

      // Resolve metadata one-at-a-time to avoid ordering issues
      const metaMap = new Map<string, { name: string; ticker: string; iconUri: string | null }>();
      await Promise.all(
        uniqueIds.map(async id => {
          try {
            const [info] = await rpc<[{ type: string; content: { metadata?: { name?: { text: string | null; hex: string }; ticker?: { text: string | null; hex: string }; icon_uri?: { text: string | null; hex: string } | null } } } | null]>(
              "node_get_tokens_info",
              { token_ids: [id] },
            );
            if (info?.type === "NonFungibleToken") {
              const meta = info.content.metadata!;
              metaMap.set(id, {
                name:    hexToText(meta.name)    || id.slice(0, 8) + "…",
                ticker:  hexToText(meta.ticker)  || "",
                iconUri: resolveUri(meta.icon_uri ? (hexToText(meta.icon_uri) ?? null) : null),
              });
            }
          } catch {
            // skip unresolvable token
          }
        }),
      );

      const enriched: NFTListing[] = nftCandidates
        .filter(o => {
          const id = (o.initially_given as { type: "Token"; content: { id: string } }).content.id;
          return metaMap.has(id);
        })
        .map(o => {
          const id = (o.initially_given as { type: "Token"; content: { id: string } }).content.id;
          const meta = metaMap.get(id)!;
          return {
            orderId: o.order_id,
            nftId: id,
            name: meta.name,
            ticker: meta.ticker,
            iconUri: meta.iconUri,
            priceML: o.ask_balance.decimal,
            isOwn: o.is_own,
          };
        });

      setListings(enriched);
    } catch (err) {
      setBrowseError(friendlyError(err));
    } finally {
      setBrowseLoading(false);
    }
  }

  async function loadMyListings() {
    setMyListingsLoading(true);
    try {
      const raw = await rpc<OrderInfo[]>("order_list_own", { account: 0 });

      const nftSells = raw.filter(
        o =>
          o.initially_given.type === "Token" &&
          o.initially_given.content.amount.atoms === "1" &&
          !o.is_marked_as_concluded_in_wallet &&
          o.existing_order_data !== null,
      );

      const uniqueIds = [
        ...new Set(
          nftSells.map(
            o => (o.initially_given as { type: "Token"; content: { id: string } }).content.id,
          ),
        ),
      ];

      const metaMap = new Map<string, { name: string; ticker: string; iconUri: string | null }>();
      await Promise.all(
        uniqueIds.map(async id => {
          try {
            const [info] = await rpc<[{ type: string; content: { metadata?: { name?: { text: string | null; hex: string }; ticker?: { text: string | null; hex: string }; icon_uri?: { text: string | null; hex: string } | null } } } | null]>(
              "node_get_tokens_info",
              { token_ids: [id] },
            );
            if (info?.type === "NonFungibleToken") {
              const meta = info.content.metadata!;
              metaMap.set(id, {
                name:    hexToText(meta.name)    || id.slice(0, 8) + "…",
                ticker:  hexToText(meta.ticker)  || "",
                iconUri: resolveUri(meta.icon_uri ? (hexToText(meta.icon_uri) ?? null) : null),
              });
            }
          } catch {
            // skip
          }
        }),
      );

      const enriched: NFTListing[] = nftSells
        .filter(o => {
          const id = (o.initially_given as { type: "Token"; content: { id: string } }).content.id;
          return metaMap.has(id);
        })
        .map(o => {
          const id = (o.initially_given as { type: "Token"; content: { id: string } }).content.id;
          const meta = metaMap.get(id)!;
          const data = o.existing_order_data!;
          return {
            orderId: o.order_id,
            nftId: id,
            name: meta.name,
            ticker: meta.ticker,
            iconUri: meta.iconUri,
            priceML: data.ask_balance.decimal,
            isOwn: true,
          };
        });

      setMyListings(enriched);
    } catch {
      // non-critical, silently ignore
    } finally {
      setMyListingsLoading(false);
    }
  }

  // ── Derived ─────────────────────────────────────────────────────────────────

  const tabBtnCls = (active: boolean) =>
    `px-5 py-2 text-sm font-medium rounded-lg transition-colors ${
      active
        ? "bg-gray-800 text-gray-100"
        : "text-gray-500 hover:text-gray-300"
    }`;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Inner tab bar */}
      <div className="flex gap-1 mb-6 border-b border-gray-800 pb-3">
        <button className={tabBtnCls(tab === "browse")} onClick={() => setTab("browse")}>
          Browse &amp; Buy
        </button>
        <button className={tabBtnCls(tab === "sell")} onClick={() => setTab("sell")}>
          Sell Your NFT
        </button>
      </div>

      {/* ── Browse tab ─────────────────────────────────────────────────────── */}
      {tab === "browse" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-gray-500">NFTs currently listed for sale</p>
            <button
              onClick={loadListings}
              disabled={browseLoading}
              className="rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 px-3 py-1.5 text-xs text-gray-300 transition-colors disabled:opacity-50"
            >
              {browseLoading ? "Loading…" : "Refresh"}
            </button>
          </div>

          {browseError && (
            <div className="rounded-lg border border-red-700 bg-red-900/30 p-4 mb-4 text-red-300 text-sm">
              {browseError}
            </div>
          )}

          {browseLoading && listings.length === 0 && (
            <div className="py-16 text-center text-gray-600 text-sm">Loading listings…</div>
          )}

          {!browseLoading && listings.length === 0 && !browseError && (
            <div className="py-16 text-center text-gray-600 text-sm">
              No NFT listings yet. Be the first to list one!
            </div>
          )}

          {listings.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {listings.map(listing => (
                <NFTCard
                  key={listing.orderId}
                  listing={listing}
                  showBuy={!listing.isOwn}
                  showCancel={false}
                  onAction={loadListings}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Sell modal ─────────────────────────────────────────────────────── */}
      {sellModalNFT && (
        <SellNFTModal
          nft={sellModalNFT}
          onClose={() => setSellModalNFT(null)}
          onDone={async () => {
            setSellModalNFT(null);
            await loadMyListings();
          }}
        />
      )}

      {/* ── Sell tab ───────────────────────────────────────────────────────── */}
      {tab === "sell" && (
        <div className="space-y-8">

          {/* NFT picker */}
          <div>
            <h2 className="text-base font-semibold text-gray-100 mb-4">List an NFT for Sale</h2>

            {ownedNFTs.length === 0 ? (
              <p className="text-sm text-gray-500">You don't own any NFTs yet.</p>
            ) : (
              <div>
                <p className="text-xs text-gray-500 mb-3 font-medium uppercase tracking-wide">
                  Click an NFT to set a price and list it
                </p>
                <div className="grid grid-cols-3 gap-3">
                  {ownedNFTs.map(nft => (
                    <button
                      key={nft.tokenId}
                      type="button"
                      onClick={() => setSellModalNFT(nft)}
                      className="rounded-xl p-3 flex flex-col gap-2 text-left border-2 border-gray-700 bg-gray-900 hover:border-mint-600 hover:bg-gray-800 transition-all"
                    >
                      <NFTImage uri={resolveUri(nft.iconUri)} name={nft.name} />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-gray-100 truncate">{nft.name}</p>
                        {nft.ticker && (
                          <p className="text-xs font-mono text-gray-500 truncate">{nft.ticker}</p>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* My active listings */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-gray-100">My Active Listings</h2>
              <button
                onClick={loadMyListings}
                disabled={myListingsLoading}
                className="rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 px-3 py-1.5 text-xs text-gray-300 transition-colors disabled:opacity-50"
              >
                {myListingsLoading ? "Loading…" : "Refresh"}
              </button>
            </div>

            {myListingsLoading && myListings.length === 0 && (
              <div className="py-8 text-center text-gray-600 text-sm">Loading…</div>
            )}

            {!myListingsLoading && myListings.length === 0 && (
              <div className="py-8 text-center text-gray-600 text-sm">
                No active NFT listings.
              </div>
            )}

            {myListings.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {myListings.map(listing => (
                  <NFTCard
                    key={listing.orderId}
                    listing={listing}
                    showBuy={false}
                    showCancel={true}
                    onAction={loadMyListings}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
