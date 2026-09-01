import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn<typeof fetch>();

vi.mock('@/lib/bitcoin-wallet', () => ({
  isBitcoinEnabled: vi.fn(),
  getBitcoinStatus: vi.fn(),
  currentBitcoinAddress: vi.fn(),
  getBitcoinBalance: vi.fn(),
  listBitcoinTransactions: vi.fn(),
  createBitcoinWallet: vi.fn(),
  sendBitcoin: vi.fn(),
  triggerBitcoinSync: vi.fn(),
  BitcoinWalletError: class BitcoinWalletError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import {
  isBitcoinEnabled,
  getBitcoinStatus,
  currentBitcoinAddress,
  getBitcoinBalance,
  listBitcoinTransactions,
  createBitcoinWallet,
  sendBitcoin,
  triggerBitcoinSync,
} from '@/lib/bitcoin-wallet';

beforeEach(() => {
  vi.mocked(isBitcoinEnabled).mockReturnValue(true);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('GET /api/bitcoin/overview', () => {
  const makeCtx = () =>
    ({ request: new Request('http://localhost/api/bitcoin/overview') }) as never;

  it('returns 404 when bitcoin is disabled', async () => {
    vi.mocked(isBitcoinEnabled).mockReturnValue(false);
    const { GET } = await import('@/pages/api/bitcoin/overview');
    const res = await GET(makeCtx());
    expect(res.status).toBe(404);
  });

  it('aggregates status, address, balance and transactions', async () => {
    const statusPayload = {
      ok: true, network: "mainnet" as const, walletExists: true, walletLoaded: true,
      node: { reachable: true, blocks: 1, headers: 1, synced: true, initialBlockDownload: false },
      balance: { confirmed: '1', trustedPending: '0', untrustedPending: '0', immature: '0' },
    };
    vi.mocked(getBitcoinStatus).mockResolvedValue(statusPayload);
    vi.mocked(currentBitcoinAddress).mockResolvedValue({ ok: true, address: 'bc1qabc' });
    vi.mocked(getBitcoinBalance).mockResolvedValue({
      confirmed: "1", trustedPending: "0", untrustedPending: "0", immature: "0", total: "1",
    });
    vi.mocked(listBitcoinTransactions).mockResolvedValue({
      ok: true,
      transactions: [{ txid: 't1', received: '1', sent: '0', fee: null, confirmed: true, height: 5, timestamp: 1700000000 }],
    });

    const { GET } = await import('@/pages/api/bitcoin/overview');
    const res = await GET(makeCtx());
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.address).toBe('bc1qabc');
    expect((body.transactions as unknown[]).length).toBe(1);
  });

  it('degrades gracefully when the sidecar is fully unreachable', async () => {
    const boom = () => Promise.reject(new Error('unreachable'));
    vi.mocked(getBitcoinStatus).mockImplementation(boom);
    vi.mocked(currentBitcoinAddress).mockImplementation(boom);
    vi.mocked(getBitcoinBalance).mockImplementation(boom);
    vi.mocked(listBitcoinTransactions).mockImplementation(boom);

    const { GET } = await import('@/pages/api/bitcoin/overview');
    const res = await GET(makeCtx());
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.status).toBeNull();
    expect(body.address).toBeNull();
    expect(body.transactions).toBeNull();
  });
});

describe('POST /api/bitcoin/wallet', () => {
  const makeCtx = (body: unknown) =>
    ({ request: new Request('http://localhost/api/bitcoin/wallet', { method: 'POST', body: JSON.stringify(body) }) }) as never;

  it('returns 404 when bitcoin is disabled', async () => {
    vi.mocked(isBitcoinEnabled).mockReturnValue(false);
    const { POST } = await import('@/pages/api/bitcoin/wallet');
    const res = await POST(makeCtx({}));
    expect(res.status).toBe(404);
  });

  it('proxies creation and returns the one-time mnemonic', async () => {
    vi.mocked(createBitcoinWallet).mockResolvedValue({ ok: true, created: true, network: 'mainnet', mnemonic: 'w1 w2 w3' });
    const { POST } = await import('@/pages/api/bitcoin/wallet');
    const res = await POST(makeCtx({}));
    const body = await res.json() as Record<string, unknown>;
    expect(body.mnemonic).toBe('w1 w2 w3');
    expect(vi.mocked(createBitcoinWallet)).toHaveBeenCalledWith(undefined);
  });

  it('forwards the provided seed for restore', async () => {
    vi.mocked(createBitcoinWallet).mockResolvedValue({ ok: true, created: true, network: 'mainnet' });
    const { POST } = await import('@/pages/api/bitcoin/wallet');
    await POST(makeCtx({ seed: 'w1 w2 w3' }));
    expect(vi.mocked(createBitcoinWallet)).toHaveBeenCalledWith('w1 w2 w3');
  });

  it('maps 409 (already exists) to a 409 response', async () => {
    vi.mocked(createBitcoinWallet).mockRejectedValue(
      Object.assign(new Error('wallet already exists'), { status: 409 }),
    );
    const { POST } = await import('@/pages/api/bitcoin/wallet');
    const res = await POST(makeCtx({}));
    expect(res.status).toBe(409);
  });
});

describe('POST /api/bitcoin/send', () => {
  const makeCtx = (body: unknown) =>
    ({ request: new Request('http://localhost/api/bitcoin/send', { method: 'POST', body: JSON.stringify(body) }) }) as never;

  it('rejects invalid amounts', async () => {
    const { POST } = await import('@/pages/api/bitcoin/send');
    for (const bad of ['', 'abc', '-1', '0', '0.000000001', '1.23456789012']) {
      const res = await POST(makeCtx({ address: 'bc1qabc', amount_btc: bad }));
      expect(res.status).toBe(400);
    }
  });

  it('rejects a missing address', async () => {
    const { POST } = await import('@/pages/api/bitcoin/send');
    const res = await POST(makeCtx({ amount_btc: '0.5' }));
    expect(res.status).toBe(400);
  });

  it('proxies a valid send', async () => {
    vi.mocked(sendBitcoin).mockResolvedValue({ ok: true, txid: 'deadbeef' });
    const { POST } = await import('@/pages/api/bitcoin/send');
    const res = await POST(makeCtx({ address: 'bc1qabc', amount_btc: '0.5', fee_rate_sat_vb: 10 }));
    const body = await res.json() as Record<string, unknown>;
    expect(body.txid).toBe('deadbeef');
    expect(vi.mocked(sendBitcoin)).toHaveBeenCalledWith({ address: 'bc1qabc', amountBtc: '0.5', feeRateSatVb: 10 });
  });

  it('keeps the sidecar 503 as 503', async () => {
    vi.mocked(sendBitcoin).mockRejectedValue(
      Object.assign(new Error('BTC wallet service unreachable'), { status: 503 }),
    );
    const { POST } = await import('@/pages/api/bitcoin/send');
    const res = await POST(makeCtx({ address: 'bc1qabc', amount_btc: '0.5' }));
    expect(res.status).toBe(503);
  });
});

describe('POST /api/bitcoin/sync', () => {
  it('returns 404 when bitcoin is disabled', async () => {
    vi.mocked(isBitcoinEnabled).mockReturnValue(false);
    const { POST } = await import('@/pages/api/bitcoin/sync');
    const res = await POST({ request: new Request('http://localhost/api/bitcoin/sync', { method: 'POST' }) } as never);
    expect(res.status).toBe(404);
  });

  it('proxies the sync trigger', async () => {
    vi.mocked(triggerBitcoinSync).mockResolvedValue({ ok: true, syncStarted: true });
    const { POST } = await import('@/pages/api/bitcoin/sync');
    const res = await POST({ request: new Request('http://localhost/api/bitcoin/sync', { method: 'POST' }) } as never);
    const body = await res.json() as Record<string, unknown>;
    expect(body.syncStarted).toBe(true);
  });
});
