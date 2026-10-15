import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTokensInfoByIds, TOKEN_INFO_CHUNK_SIZE } from './token-info-client';
import type { TokenInfo } from './wallet-rpc';

vi.mock('@/lib/client-rpc', () => ({
  rpc: vi.fn(),
}));

import { rpc } from '@/lib/client-rpc';
const rpcMock = vi.mocked(rpc);

function fungible(tokenId: string): TokenInfo {
  return {
    type: 'FungibleToken',
    content: {
      token_id: tokenId,
      token_ticker: { text: 'T', hex: '0x54' },
      number_of_decimals: 18,
      metadata_uri: { text: null, hex: '' },
      circulating_supply: { atoms: '0' },
      total_supply: { type: 'Unlimited' },
      is_locked: false,
      frozen: { type: 'NotFrozen' },
      authority: '0xdeadbeef',
    },
  } as unknown as TokenInfo;
}

describe('getTokensInfoByIds', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('aligns shuffled responses by content.token_id', async () => {
    rpcMock.mockResolvedValueOnce([fungible('b'), null, fungible('a')]);
    const map = await getTokensInfoByIds(['a', 'b', 'c']);
    expect(map.get('a')?.type).toBe('FungibleToken');
    expect(map.get('b')?.type).toBe('FungibleToken');
    expect(map.get('c')).toBeNull();
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0]?.[1]).toEqual({ token_ids: ['a', 'b', 'c'] });
  });

  it('chunks large id lists and deduplicates', async () => {
    const ids = Array.from({ length: TOKEN_INFO_CHUNK_SIZE + 7 }, (_, i) => `id${i}`);
    rpcMock.mockImplementation(
      (_m: string, p?: Record<string, unknown>) =>
        Promise.resolve(
          ((p as { token_ids: string[] }).token_ids).map((id) => fungible(id)),
        ),
    );
    const map = await getTokensInfoByIds([...ids, 'id0']);
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(map.size).toBe(ids.length);
    expect(map.get('id0')?.type).toBe('FungibleToken');
    expect(map.get('id56')?.type).toBe('FungibleToken');
  });

  it('keeps other chunks resolvable when one chunk fails', async () => {
    const ids = Array.from({ length: TOKEN_INFO_CHUNK_SIZE + 1 }, (_, i) => `id${i}`);
    rpcMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([fungible(`id${TOKEN_INFO_CHUNK_SIZE}`)]);
    const map = await getTokensInfoByIds(ids);
    expect(map.get('id0')).toBeNull();
    expect(map.get(`id${TOKEN_INFO_CHUNK_SIZE}`)?.type).toBe('FungibleToken');
  });

  it('handles a failing rpc gracefully for a single chunk', async () => {
    rpcMock.mockRejectedValue(new Error('down'));
    const map = await getTokensInfoByIds(['x', 'y']);
    expect(map.get('x')).toBeNull();
    expect(map.get('y')).toBeNull();
  });
});
