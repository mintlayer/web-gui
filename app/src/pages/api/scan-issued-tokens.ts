/**
 * /api/scan-issued-tokens
 *
 * Scans the wallet's UTXO set for IssueFungibleToken and IssueNft outputs,
 * which represent tokens for which this wallet currently holds authority.
 *
 * Works WITHOUT the indexer — uses only the wallet-rpc-daemon.
 *
 * For fungible tokens: computes the token_id from the first UTXO input of the
 * issuance transaction using the Mintlayer derivation:
 *   token_id = bech32m(hrp, blake2b512(scale_encode(TxInput::Utxo(first_input))).slice(0, 32))
 *
 * Returns: { ok: true, fungible: [{tokenId, ticker, decimals}], nfts: [{tokenId}] }
 */

import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { rpcCall } from '@/lib/wallet-rpc';
import { hexToText } from '@/lib/token-utils';
import { json } from '@/lib/api-utils';
import { encodeWords, toWords } from '@/lib/bech32';

// ── Network HRP ───────────────────────────────────────────────────────────────

const NETWORK = (process.env.NETWORK ?? 'mainnet').toLowerCase();
const TOKEN_ID_HRP: Record<string, string> = {
  mainnet: 'mmltk',
  testnet: 'tmltk',
  regtest: 'rmltk',
  signet:  'smltk',
};
const hrp = TOKEN_ID_HRP[NETWORK] ?? 'mmltk';

// ── Token ID computation ──────────────────────────────────────────────────────

function computeTokenId(prevTxIdHex: string, prevOutputIndex: number): string | null {
  try {
    const txIdBytes = Buffer.from(prevTxIdHex, 'hex');
    if (txIdBytes.length !== 32) return null;
    const indexBytes = Buffer.alloc(4);
    indexBytes.writeUInt32LE(prevOutputIndex, 0);
    // SCALE encode: [TxInput::Utxo=0x00][OutPointSourceId::Transaction=0x00][32 bytes][4 bytes LE]
    const encoded = Buffer.concat([Buffer.from([0x00, 0x00]), txIdBytes, indexBytes]);
    const hash64 = createHash('blake2b512').update(encoded).digest();
    return encodeWords(hrp, toWords(hash64.subarray(0, 32)));
  } catch {
    return null;
  }
}

// ── UTXO types ────────────────────────────────────────────────────────────────

interface UtxoEntry {
  outpoint: {
    source_id: {
      type: 'Transaction' | 'BlockReward';
      content: { tx_id: string };
    };
    index: number;
  };
  output:
    | {
        type: 'IssueFungibleToken';
        content: {
          data: {
            token_ticker: { text: string | null; hex: string };
            number_of_decimals: number;
            authority: string;
          };
        };
      }
    | {
        type: 'IssueNft';
        content: {
          token_id: string;
          data: unknown;
          destination: string;
        };
      }
    | { type: string };
}

// transaction_get returns a 2-element tuple [Transaction, TxState] serialized as JSON
// Transaction is {"V1": {"version": N, "flags": N, "inputs": [...], "outputs": [...]}}
// Each UTXO input is {"Utxo": {"id": {"Transaction": "<64-hex>"}, "index": N}}
interface TxGetResult {
  V1?: {
    inputs?: Array<{
      Utxo?: {
        id?: { Transaction?: string };
        index?: number;
      };
    }>;
  };
}

// ── Endpoint ──────────────────────────────────────────────────────────────────

export const GET: APIRoute = async () => {
  try {
    const utxos = await rpcCall<UtxoEntry[]>('account_utxos', { account: 0 });

    const fungibleResult: Array<{ tokenId: string; ticker: string; decimals: number }> = [];
    const nftResult: Array<{ tokenId: string }> = [];

    for (const utxo of utxos) {
      if (utxo.output.type === 'IssueNft') {
        const nftOutput = utxo.output as Extract<UtxoEntry['output'], { type: 'IssueNft' }>;
        if (nftOutput.content.token_id) {
          nftResult.push({ tokenId: nftOutput.content.token_id });
        }
        continue;
      }

      if (utxo.output.type !== 'IssueFungibleToken') continue;
      if (utxo.outpoint.source_id.type !== 'Transaction') continue;

      const issuanceTxId = utxo.outpoint.source_id.content.tx_id;
      const ftOutput = utxo.output as Extract<UtxoEntry['output'], { type: 'IssueFungibleToken' }>;
      const ticker = hexToText(ftOutput.content.data.token_ticker) ?? '???';
      const decimals = ftOutput.content.data.number_of_decimals;

      // Get the issuance transaction to find its first UTXO input
      let txJson: [TxGetResult, unknown] | null = null;
      try {
        txJson = await rpcCall<[TxGetResult, unknown]>('transaction_get', {
          account: 0,
          transaction_id: issuanceTxId,
        });
      } catch {
        continue;
      }

      if (!Array.isArray(txJson) || !txJson[0]) continue;
      const txData = txJson[0] as TxGetResult;
      const inputs = txData.V1?.inputs;
      if (!Array.isArray(inputs) || inputs.length === 0) continue;

      // Find the first UTXO input
      const firstUtxoInput = inputs.find(inp => inp.Utxo?.id?.Transaction !== undefined);
      if (!firstUtxoInput?.Utxo) continue;

      const prevTxIdHex = firstUtxoInput.Utxo.id?.Transaction;
      const prevOutputIndex = firstUtxoInput.Utxo.index;
      if (!prevTxIdHex || prevOutputIndex === undefined) continue;

      const tokenId = computeTokenId(prevTxIdHex, prevOutputIndex);
      if (!tokenId) continue;

      fungibleResult.push({ tokenId, ticker, decimals });
    }

    return json({ ok: true, fungible: fungibleResult, nfts: nftResult }, 200);
  } catch {
    // Best-effort — never crash the page
    return json({ ok: true, fungible: [], nfts: [] }, 200);
  }
};
