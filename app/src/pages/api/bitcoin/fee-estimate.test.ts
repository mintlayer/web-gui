import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/bitcoin-wallet', () => ({
  isBitcoinEnabled: vi.fn(),
  getBitcoinFeeEstimate: vi.fn(),
}));

vi.mock('@/lib/step-up', () => ({
  requireStepUp: vi.fn(),
  totpFromBody: vi.fn(() => ''),
}));

import { isBitcoinEnabled, getBitcoinFeeEstimate } from '@/lib/bitcoin-wallet';

const makeCtx = () =>
  ({ request: new Request('http://localhost/api/bitcoin/fee-estimate') }) as never;

beforeEach(() => {
  vi.mocked(isBitcoinEnabled).mockReturnValue(true);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('GET /api/bitcoin/fee-estimate', () => {
  it('returns 404 when bitcoin is disabled', async () => {
    vi.mocked(isBitcoinEnabled).mockReturnValue(false);
    const { GET } = await import('@/pages/api/bitcoin/fee-estimate');
    const res = await GET(makeCtx());
    expect(res.status).toBe(404);
  });

  it('proxies the sidecar fee payload', async () => {
    vi.mocked(getBitcoinFeeEstimate).mockResolvedValue({ ok: true, satPerVb: { '1': 12 } });
    const { GET } = await import('@/pages/api/bitcoin/fee-estimate');
    const res = await GET(makeCtx());
    const body = (await res.json()) as { ok: boolean; satPerVb: Record<string, number> };
    expect(res.status).toBe(200);
    expect(body.satPerVb['1']).toBe(12);
  });

  it('degrades to an empty estimate when the sidecar fails', async () => {
    vi.mocked(getBitcoinFeeEstimate).mockRejectedValue(new Error('sidecar down'));
    const { GET } = await import('@/pages/api/bitcoin/fee-estimate');
    const res = await GET(makeCtx());
    const body = (await res.json()) as { ok: boolean; satPerVb: Record<string, number> };
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, satPerVb: {} });
  });
});
