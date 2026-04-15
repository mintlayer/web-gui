"use client";

import { useState, useEffect } from "react";
import { hexToText } from "@/lib/token-utils";
import { CopyButton } from "@/components/CopyButton";

interface NFTEntry {
  tokenId: string;
  name: string;
  ticker: string;
  iconUri: string | null;
}

interface Props {
  network: string;
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

// ── Image cell ────────────────────────────────────────────────────────────────

function NFTImageCell({ uri, name }: { uri: string | null; name: string }) {
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

// ── Main component ────────────────────────────────────────────────────────────

export default function OwnedNFTsPanel({ network }: Props) {
  const [nfts, setNfts] = useState<NFTEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const explorerBase =
    network === "testnet"
      ? "https://lovelace.explorer.mintlayer.org"
      : "https://explorer.mintlayer.org";

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const balance = await rpc<{
        coins: unknown;
        tokens: Record<string, { atoms: string; decimal: string }>;
      }>("account_balance", {
        account: 0,
        utxo_states: ["Confirmed"],
        with_locked: "Any",
      });

      const tokenIds = Object.keys(balance.tokens);
      if (tokenIds.length === 0) {
        setNfts([]);
        return;
      }

      // Call one-at-a-time to guarantee ID→info alignment
      const infos = await Promise.all(
        tokenIds.map(id =>
          rpc<[{ type: string; content: { metadata: { name: { text: string | null; hex: string }; ticker: { text: string | null; hex: string }; icon_uri: { text: string | null; hex: string } | null } } } | null]>(
            "node_get_tokens_info",
            { token_ids: [id] },
          )
            .then(([info]) => ({ id, info }))
            .catch(() => ({ id, info: null })),
        ),
      );

      const result: NFTEntry[] = infos
        .filter(({ info }) => info?.type === "NonFungibleToken")
        .map(({ id, info }) => {
          const meta = (info as { type: string; content: { metadata: { name: { text: string | null; hex: string }; ticker: { text: string | null; hex: string }; icon_uri: { text: string | null; hex: string } | null } } }).content.metadata;
          return {
            tokenId: id,
            name: hexToText(meta.name) || id.slice(0, 8) + "…",
            ticker: hexToText(meta.ticker) || "",
            iconUri: resolveUri(meta.icon_uri ? (hexToText(meta.icon_uri) ?? null) : null),
          };
        });

      setNfts(result);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.toLowerCase().includes('no wallet') || msg.toLowerCase().includes('wallet not open')) {
        window.location.href = '/';
        return;
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-700 bg-red-900/30 p-4 text-red-300 text-sm">
        {error}
      </div>
    );
  }

  if (nfts.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        No NFTs in your wallet. Use <strong className="text-gray-400">Mint NFT</strong> above to create one.
      </p>
    );
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button
          onClick={load}
          className="rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 px-3 py-1.5 text-xs text-gray-300 transition-colors"
        >
          Refresh
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {nfts.map(nft => (
          <div key={nft.tokenId} className="rounded-xl bg-gray-900 border border-gray-800 p-4 flex flex-col gap-3">
            <NFTImageCell uri={nft.iconUri} name={nft.name} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-sm font-semibold text-gray-100 truncate">{nft.name}</span>
                {nft.ticker && (
                  <span className="rounded bg-gray-800 border border-gray-700 px-1.5 py-0.5 text-xs font-mono text-gray-400">
                    {nft.ticker}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <a
                  href={`${explorerBase}/nft/${nft.tokenId}`}
                  target="_blank"
                  rel="noopener"
                  className="font-mono text-xs text-mint-400 hover:text-mint-300 transition-colors"
                >
                  {nft.tokenId.slice(0, 16)}…
                </a>
                <CopyButton value={nft.tokenId} title="Copy NFT ID" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
