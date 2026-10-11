import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  verifySessionToken: vi.fn(),
  SESSION_COOKIE_NAME: 'ml_session',
}));

vi.mock('@/lib/prefs-db', () => ({
  getPref: vi.fn(),
}));

vi.mock('@/lib/indexer', () => ({
  getTransactionInfo: vi.fn(),
  isPendingIndexerTransaction: vi.fn(),
}));

vi.mock('@/lib/indexer-capabilities', () => ({
  getIndexerCapabilities: vi.fn(),
}));

import { GET } from '@/pages/api/tx-status';
import { verifySessionToken } from '@/lib/auth';
import { getPref } from '@/lib/prefs-db';
import { getTransactionInfo, isPendingIndexerTransaction } from '@/lib/indexer';
import { getIndexerCapabilities } from '@/lib/indexer-capabilities';

const HEX_ID = 'a'.repeat(64);

function makeCtx(id: string | null) {
  const qs = id === null ? '' : `?id=${encodeURIComponent(id)}`;
  const url = new URL(`http://localhost/api/tx-status${qs}`);
  return {
    request: new Request(url.toString()),
    url,
  } as unknown as Parameters<typeof GET>[0];
}

describe('GET /api/tx-status', () => {
  beforeEach(() => {
    vi.mocked(verifySessionToken).mockReturnValue(true);
    vi.mocked(getPref).mockReturnValue(1);
    vi.mocked(getIndexerCapabilities).mockResolvedValue({ mempoolApi: true, stream: true });
  });

  it('401s when the session token is not valid', async () => {
    vi.mocked(verifySessionToken).mockReturnValue(false);
    const res = await GET(makeCtx(HEX_ID));
    expect(res.status).toBe(401);
    expect(getTransactionInfo).not.toHaveBeenCalled();
  });

  it('400s on a malformed transaction id', async () => {
    const res = await GET(makeCtx('not-hex'));
    expect(res.status).toBe(400);
    expect(getTransactionInfo).not.toHaveBeenCalled();
  });

  it('400s when the id parameter is missing', async () => {
    const res = await GET(makeCtx(null));
    expect(res.status).toBe(400);
  });

  it('reports pending for a mempool transaction (null block/confirmations)', async () => {
    const info = { id: HEX_ID, block_id: null, timestamp: null, confirmations: null, inputs: [], outputs: [] };
    vi.mocked(getTransactionInfo).mockResolvedValue(info);
    vi.mocked(isPendingIndexerTransaction).mockReturnValue(true);

    const res = await GET(makeCtx(HEX_ID));
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ status: 'pending', confirmations: null });
    expect(getTransactionInfo).toHaveBeenCalledWith(HEX_ID);
  });

  it('reports confirmed with block/timestamp/confirmations once on chain', async () => {
    const info = {
      id: HEX_ID, block_id: '0xabc', timestamp: 1_700_000_000, confirmations: 7,
      inputs: [], outputs: [],
    };
    vi.mocked(getTransactionInfo).mockResolvedValue(info);
    vi.mocked(isPendingIndexerTransaction).mockReturnValue(false);

    const res = await GET(makeCtx(HEX_ID));
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({
      status: 'confirmed',
      confirmations: 7,
      block_id: '0xabc',
      timestamp: 1_700_000_000,
    });
  });

  it('reports unknown when the indexer cannot see the tx at all', async () => {
    vi.mocked(getTransactionInfo).mockRejectedValue(new Error('Indexer error 404: not found'));
    const res = await GET(makeCtx(HEX_ID));
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ status: 'unknown', reason: 'not-in-mempool-or-chain' });
  });

  it('falls back to a confirmed-only lookup when the indexer is pre-1.4.1', async () => {
    vi.mocked(getIndexerCapabilities).mockResolvedValue({ mempoolApi: false, stream: false });
    const info = {
      id: HEX_ID, block_id: '0xabc', timestamp: 1_700_000_000, confirmations: 3,
      inputs: [], outputs: [],
    };
    vi.mocked(getTransactionInfo).mockResolvedValue(info);
    vi.mocked(isPendingIndexerTransaction).mockReturnValue(false);

    const res = await GET(makeCtx(HEX_ID));
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('confirmed');
  });

  it('reports unknown (not pending) on a legacy indexer miss', async () => {
    vi.mocked(getIndexerCapabilities).mockResolvedValue({ mempoolApi: false, stream: false });
    vi.mocked(getTransactionInfo).mockRejectedValue(new Error('Indexer error 404: not found'));

    const res = await GET(makeCtx(HEX_ID));
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ status: 'unknown', reason: 'legacy-indexer-pending-unknown' });
  });

  it('reports unknown when the indexer is unreachable', async () => {
    vi.mocked(getIndexerCapabilities).mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = await GET(makeCtx(HEX_ID));
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ status: 'unknown', reason: 'indexer-unavailable' });
  });
});
