import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  verifySessionToken: vi.fn(),
  SESSION_COOKIE_NAME: 'ml_session',
}));

vi.mock('@/lib/prefs-db', () => ({
  getPref: vi.fn(),
}));

vi.mock('@/lib/indexer', () => ({
  getTokenStatistics: vi.fn(),
  listTokenHolders: vi.fn(),
}));

vi.mock('@/lib/indexer-capabilities', () => ({
  getIndexerCapabilities: vi.fn(),
}));

import { GET } from '@/pages/api/token-intel';
import { verifySessionToken } from '@/lib/auth';
import { getPref } from '@/lib/prefs-db';
import { getTokenStatistics, listTokenHolders } from '@/lib/indexer';
import { getIndexerCapabilities } from '@/lib/indexer-capabilities';

const TOKEN_ID = 'tml_1';

const STATS = {
  circulating_supply: { atoms: '100', decimal: '100' },
  preminted: { atoms: '10', decimal: '10' },
  burned: { atoms: '5', decimal: '5' },
  staked: { atoms: '20', decimal: '20' },
};

const HOLDERS = {
  items: [{ address: 'mt1qabc', amount: { atoms: '50', decimal: '50' } }],
  next_cursor: null,
};

function makeCtx(tokenId: string | null) {
  const qs = tokenId === null ? '' : `?token_id=${encodeURIComponent(tokenId)}`;
  const url = new URL(`http://localhost/api/token-intel${qs}`);
  return { request: new Request(url.toString()), url } as unknown as Parameters<typeof GET>[0];
}

describe('GET /api/token-intel', () => {
  beforeEach(() => {
    vi.mocked(verifySessionToken).mockClear();
    vi.mocked(getTokenStatistics).mockClear();
    vi.mocked(listTokenHolders).mockClear();
    vi.mocked(verifySessionToken).mockReturnValue(true);
    vi.mocked(getPref).mockReturnValue(1);
    vi.mocked(getIndexerCapabilities).mockResolvedValue({ mempoolApi: true, stream: true });
    vi.mocked(getTokenStatistics).mockResolvedValue(STATS);
    vi.mocked(listTokenHolders).mockResolvedValue(HOLDERS);
  });

  it('401s without a valid session', async () => {
    vi.mocked(verifySessionToken).mockReturnValue(false);
    const res = await GET(makeCtx(TOKEN_ID));
    expect(res.status).toBe(401);
    expect(getTokenStatistics).not.toHaveBeenCalled();
  });

  it('400s on a missing token id', async () => {
    const res = await GET(makeCtx(null));
    expect(res.status).toBe(400);
  });

  it('returns statistics + holders for a 1.4.1 indexer', async () => {
    const res = await GET(makeCtx(TOKEN_ID));
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.statistics).toEqual(STATS);
    expect(body.holders).toEqual(HOLDERS.items);
    expect(body.moreHolders).toBe(false);
    expect(listTokenHolders).toHaveBeenCalledWith(TOKEN_ID, { items: 10 });
  });

  it('flags moreHolders when a cursor remains', async () => {
    vi.mocked(listTokenHolders).mockResolvedValue({ ...HOLDERS, next_cursor: 'abc' });
    const res = await GET(makeCtx(TOKEN_ID));
    const body = await res.json() as Record<string, unknown>;
    expect(body.moreHolders).toBe(true);
  });

  it('reports requires-1.4.1 on an older indexer instead of partial data', async () => {
    vi.mocked(getIndexerCapabilities).mockResolvedValue({ mempoolApi: false, stream: false });
    const res = await GET(makeCtx(TOKEN_ID));
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ ok: false, reason: 'requires-1.4.1' });
    expect(getTokenStatistics).not.toHaveBeenCalled();
  });

  it('reports indexer-unavailable when the indexer cannot be reached', async () => {
    vi.mocked(getIndexerCapabilities).mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await GET(makeCtx(TOKEN_ID));
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ ok: false, reason: 'indexer-unavailable' });
  });

  it('answers ok:false when the statistics lookup fails', async () => {
    vi.mocked(getTokenStatistics).mockRejectedValue(new Error('Indexer error 404'));
    const res = await GET(makeCtx(TOKEN_ID));
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ ok: false, reason: 'indexer-request-failed' });
  });
});
