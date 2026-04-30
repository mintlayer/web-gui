import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/wallet-rpc', () => ({
  rpcCall: vi.fn(),
}));

vi.mock('@/lib/token-utils', () => ({
  hexToText: vi.fn((field: { text: string | null; hex: string } | null) => field?.text ?? null),
}));

import { GET } from '@/pages/api/scan-issued-tokens';
import { rpcCall } from '@/lib/wallet-rpc';

const mockRpcCall = vi.mocked(rpcCall);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFungibleUtxo(txId = 'issuer-tx', ticker = 'TEST', decimals = 8) {
  return {
    outpoint: { source_id: { type: 'Transaction', content: { tx_id: txId } }, index: 0 },
    output: {
      type: 'IssueFungibleToken',
      content: {
        data: {
          token_ticker: { text: ticker, hex: '' },
          number_of_decimals: decimals,
          authority: 'addr',
        },
      },
    },
  };
}

function makeTxGetResult(prevTxId: string, index = 0) {
  return [
    { V1: { inputs: [{ Utxo: { id: { Transaction: prevTxId }, index } }] } },
    {},
  ];
}

const VALID_TX_ID = 'a'.repeat(64); // 32 bytes as hex

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/scan-issued-tokens', () => {
  it('returns empty arrays when UTXO list is empty', async () => {
    mockRpcCall.mockResolvedValueOnce([]);
    const res = await GET({} as Parameters<typeof GET>[0]);
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, fungible: [], nfts: [] });
  });

  it('returns empty arrays when account_utxos throws', async () => {
    mockRpcCall.mockRejectedValueOnce(new Error('wallet not open'));
    const res = await GET({} as Parameters<typeof GET>[0]);
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, fungible: [], nfts: [] });
  });

  it('skips unrecognized output types', async () => {
    mockRpcCall.mockResolvedValueOnce([
      {
        outpoint: { source_id: { type: 'Transaction', content: { tx_id: 'tx1' } }, index: 0 },
        output: { type: 'Transfer' },
      },
    ]);
    const res = await GET({} as Parameters<typeof GET>[0]);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ ok: true, fungible: [], nfts: [] });
  });

  // ── IssueNft ──────────────────────────────────────────────────────────────

  it('includes NFT from IssueNft UTXO', async () => {
    mockRpcCall.mockResolvedValueOnce([
      {
        outpoint: { source_id: { type: 'Transaction', content: { tx_id: 'tx1' } }, index: 0 },
        output: { type: 'IssueNft', content: { token_id: 'nft-id-1', data: {}, destination: 'addr' } },
      },
    ]);
    const res = await GET({} as Parameters<typeof GET>[0]);
    const body = await res.json() as { ok: boolean; nfts: Array<{ tokenId: string }>; fungible: unknown[] };
    expect(body.nfts).toEqual([{ tokenId: 'nft-id-1' }]);
    expect(body.fungible).toEqual([]);
  });

  it('skips IssueNft with empty token_id', async () => {
    mockRpcCall.mockResolvedValueOnce([
      {
        outpoint: { source_id: { type: 'Transaction', content: { tx_id: 'tx1' } }, index: 0 },
        output: { type: 'IssueNft', content: { token_id: '', data: {}, destination: 'addr' } },
      },
    ]);
    const res = await GET({} as Parameters<typeof GET>[0]);
    const body = await res.json() as { nfts: unknown[] };
    expect(body.nfts).toEqual([]);
  });

  // ── IssueFungibleToken ────────────────────────────────────────────────────

  it('skips IssueFungibleToken when source_id is not Transaction', async () => {
    mockRpcCall.mockResolvedValueOnce([
      {
        outpoint: { source_id: { type: 'BlockReward', content: { tx_id: 'tx1' } }, index: 0 },
        output: {
          type: 'IssueFungibleToken',
          content: {
            data: { token_ticker: { text: 'TICK', hex: '' }, number_of_decimals: 8, authority: 'addr' },
          },
        },
      },
    ]);
    const res = await GET({} as Parameters<typeof GET>[0]);
    const body = await res.json() as { fungible: unknown[] };
    expect(body.fungible).toEqual([]);
  });

  it('skips fungible token when transaction_get throws', async () => {
    mockRpcCall
      .mockResolvedValueOnce([makeFungibleUtxo()])
      .mockRejectedValueOnce(new Error('tx not found'));
    const res = await GET({} as Parameters<typeof GET>[0]);
    const body = await res.json() as { fungible: unknown[] };
    expect(body.fungible).toEqual([]);
  });

  it('skips fungible token when transaction_get returns non-array', async () => {
    mockRpcCall
      .mockResolvedValueOnce([makeFungibleUtxo()])
      .mockResolvedValueOnce(null);
    const res = await GET({} as Parameters<typeof GET>[0]);
    const body = await res.json() as { fungible: unknown[] };
    expect(body.fungible).toEqual([]);
  });

  it('skips fungible token when inputs array is empty', async () => {
    mockRpcCall
      .mockResolvedValueOnce([makeFungibleUtxo()])
      .mockResolvedValueOnce([{ V1: { inputs: [] } }, {}]);
    const res = await GET({} as Parameters<typeof GET>[0]);
    const body = await res.json() as { fungible: unknown[] };
    expect(body.fungible).toEqual([]);
  });

  it('skips fungible token when no Utxo input is found', async () => {
    mockRpcCall
      .mockResolvedValueOnce([makeFungibleUtxo()])
      .mockResolvedValueOnce([{ V1: { inputs: [{ Coinbase: {} }] } }, {}]);
    const res = await GET({} as Parameters<typeof GET>[0]);
    const body = await res.json() as { fungible: unknown[] };
    expect(body.fungible).toEqual([]);
  });

  it('derives bech32m token ID for fungible token issuance', async () => {
    mockRpcCall
      .mockResolvedValueOnce([makeFungibleUtxo('issuer-tx', 'ML', 8)])
      .mockResolvedValueOnce(makeTxGetResult(VALID_TX_ID, 0));

    const res = await GET({} as Parameters<typeof GET>[0]);
    const body = await res.json() as {
      ok: boolean;
      fungible: Array<{ tokenId: string; ticker: string; decimals: number }>;
      nfts: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.fungible).toHaveLength(1);
    expect(body.fungible[0].tokenId).toMatch(/^[a-z]+1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/); // bech32m
    expect(body.fungible[0].ticker).toBe('ML');
    expect(body.fungible[0].decimals).toBe(8);
  });

  it('uses ??? as ticker fallback when hexToText returns null', async () => {
    // Re-mock hexToText to return null for this test
    const { hexToText } = await import('@/lib/token-utils');
    vi.mocked(hexToText).mockReturnValueOnce(null);

    mockRpcCall
      .mockResolvedValueOnce([makeFungibleUtxo('issuer-tx', 'ANY', 0)])
      .mockResolvedValueOnce(makeTxGetResult(VALID_TX_ID, 0));

    const res = await GET({} as Parameters<typeof GET>[0]);
    const body = await res.json() as {
      fungible: Array<{ ticker: string }>;
    };
    expect(body.fungible[0].ticker).toBe('???');
  });

  it('handles multiple UTXOs of different types', async () => {
    mockRpcCall
      .mockResolvedValueOnce([
        {
          outpoint: { source_id: { type: 'Transaction', content: { tx_id: 'tx1' } }, index: 0 },
          output: { type: 'IssueNft', content: { token_id: 'nft-1', data: {}, destination: 'addr' } },
        },
        makeFungibleUtxo('issuer-tx', 'COIN', 6),
        {
          outpoint: { source_id: { type: 'Transaction', content: { tx_id: 'tx3' } }, index: 0 },
          output: { type: 'Transfer' },
        },
      ])
      .mockResolvedValueOnce(makeTxGetResult(VALID_TX_ID, 1));

    const res = await GET({} as Parameters<typeof GET>[0]);
    const body = await res.json() as {
      ok: boolean;
      nfts: Array<{ tokenId: string }>;
      fungible: Array<{ ticker: string; decimals: number }>;
    };
    expect(body.nfts).toEqual([{ tokenId: 'nft-1' }]);
    expect(body.fungible).toHaveLength(1);
    expect(body.fungible[0].ticker).toBe('COIN');
    expect(body.fungible[0].decimals).toBe(6);
  });
});
