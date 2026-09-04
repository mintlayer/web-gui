import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  process.env.BITCOIN_ENABLED = 'true';
  process.env.BITCOIN_WALLET_URL = 'http://bdk-wallet:8080';
  process.env.BITCOIN_WALLET_USERNAME = 'gui';
  process.env.BITCOIN_WALLET_PASSWORD = 'guipass';
});

afterEach(() => {
  mockFetch.mockReset();
  vi.unstubAllGlobals();
  delete process.env.BITCOIN_ENABLED;
  delete process.env.BITCOIN_WALLET_URL;
  delete process.env.BITCOIN_WALLET_USERNAME;
  delete process.env.BITCOIN_WALLET_PASSWORD;
});

describe('bitcoin-wallet client', () => {
  it('reports enabled only when BITCOIN_ENABLED=true', async () => {
    const mod = await import('@/lib/bitcoin-wallet');
    expect(mod.isBitcoinEnabled()).toBe(true);
    process.env.BITCOIN_ENABLED = 'false';
    expect(mod.isBitcoinEnabled()).toBe(false);
    delete process.env.BITCOIN_ENABLED;
    expect(mod.isBitcoinEnabled()).toBe(false);
  });

  it('sends basic auth to the sidecar', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, satPerVb: { '6': 12 } }), { status: 200 }),
    );
    const { getBitcoinFeeEstimate } = await import('@/lib/bitcoin-wallet');
    await getBitcoinFeeEstimate();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://bdk-wallet:8080/fee-estimate');
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${Buffer.from('gui:guipass').toString('base64')}`);
  });

  it('getBitcoinStatus parses the sidecar payload', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          network: 'mainnet',
          walletExists: true,
          walletLoaded: true,
          node: { reachable: true, blocks: 900000, headers: 900000, synced: true, initialBlockDownload: false },
          balance: { confirmed: '1000', trustedPending: '0', untrustedPending: '0', immature: '0' },
        }),
        { status: 200 },
      ),
    );
    const { getBitcoinStatus } = await import('@/lib/bitcoin-wallet');
    const status = await getBitcoinStatus();
    expect(status.network).toBe('mainnet');
    expect(status.walletLoaded).toBe(true);
    expect(status.balance?.confirmed).toBe('1000');
    expect(status.node.synced).toBe(true);
  });

  it('createBitcoinWallet posts the optional seed and returns the mnemonic', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, created: true, network: 'testnet', mnemonic: 'a b c' }), { status: 200 }),
    );
    const { createBitcoinWallet } = await import('@/lib/bitcoin-wallet');
    const res = await createBitcoinWallet('a b c');
    expect(res.mnemonic).toBe('a b c');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.body as string)).toBe(JSON.stringify({ seed: 'a b c' }));
  });

  it('createBitcoinWalletFromSeedWithRetry retries transient 503s and succeeds', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, created: true, network: 'mainnet' }), { status: 200 }),
      );
    const { createBitcoinWalletFromSeedWithRetry } = await import('@/lib/bitcoin-wallet');
    const res = await createBitcoinWalletFromSeedWithRetry('same seed', { delayMs: 1 });
    expect(res.created).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockFetch.mock.calls[1][1]!.body as string)).toEqual({ seed: 'same seed' });
  });

  it('createBitcoinWalletFromSeedWithRetry never retries deterministic 4xx errors', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'wallet already exists' }), { status: 409 }),
    );
    const { createBitcoinWalletFromSeedWithRetry, BitcoinWalletError } = await import('@/lib/bitcoin-wallet');
    await expect(
      createBitcoinWalletFromSeedWithRetry('same seed', { delayMs: 1 }),
    ).rejects.toThrow(BitcoinWalletError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('createBitcoinWalletFromSeedWithRetry retries a genuine HTTP 503 response', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, created: true, network: 'mainnet' }), { status: 200 }),
      );
    const { createBitcoinWalletFromSeedWithRetry } = await import('@/lib/bitcoin-wallet');
    const res = await createBitcoinWalletFromSeedWithRetry('same seed', { delayMs: 1 });
    expect(res.created).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('createBitcoinWalletFromSeedWithRetry does not retry other 5xx errors', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'persisting seed: io error' }), { status: 500 }),
    );
    const { createBitcoinWalletFromSeedWithRetry, BitcoinWalletError } = await import('@/lib/bitcoin-wallet');
    await expect(
      createBitcoinWalletFromSeedWithRetry('same seed', { delayMs: 1 }),
    ).rejects.toThrow(BitcoinWalletError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('createBitcoinWalletFromSeedWithRetry exhausts attempts then throws', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const { createBitcoinWalletFromSeedWithRetry, BitcoinWalletError } = await import('@/lib/bitcoin-wallet');
    await expect(
      createBitcoinWalletFromSeedWithRetry('same seed', { attempts: 3, delayMs: 1 }),
    ).rejects.toThrow(BitcoinWalletError);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('sendBitcoin maps camelCase args to the sidecar snake_case payload', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, txid: 'abc123' }), { status: 200 }),
    );
    const { sendBitcoin } = await import('@/lib/bitcoin-wallet');
    const res = await sendBitcoin({ address: 'bc1qxyz', amountBtc: '0.5', feeRateSatVb: 12 });
    expect(res.txid).toBe('abc123');
    expect(JSON.parse(mockFetch.mock.calls[0][1]!.body as string)).toEqual({
      address: 'bc1qxyz',
      amount_btc: '0.5',
      fee_rate_sat_vb: 12,
    });
  });

  it('throws BitcoinWalletError with sidecar error message', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: 'wallet already exists' }), { status: 409 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: 'wallet already exists' }), { status: 409 }),
      );
    const { createBitcoinWallet, BitcoinWalletError } = await import('@/lib/bitcoin-wallet');
    await expect(createBitcoinWallet()).rejects.toThrow(BitcoinWalletError);
    await expect(createBitcoinWallet()).rejects.toThrow('wallet already exists');
  });

  it('wraps network failures in a 503 BitcoinWalletError', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { getBitcoinStatus, BitcoinWalletError } = await import('@/lib/bitcoin-wallet');
    const err = await getBitcoinStatus().catch((e) => e);
    expect(err).toBeInstanceOf(BitcoinWalletError);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/unreachable/);
  });

  it('listBitcoinTransactions passes the limit param', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, transactions: [] }), { status: 200 }),
    );
    const { listBitcoinTransactions } = await import('@/lib/bitcoin-wallet');
    await listBitcoinTransactions(25);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://bdk-wallet:8080/txs?limit=25');
  });

  describe('getBitcoinExplorerUrl', () => {
    beforeEach(() => {
      delete process.env.BITCOIN_EXPLORER_URL;
      delete process.env.BITCOIN_NETWORK;
      process.env.NETWORK = 'mainnet';
    });
    afterEach(() => {
      delete process.env.BITCOIN_EXPLORER_URL;
      delete process.env.BITCOIN_NETWORK;
      delete process.env.NETWORK;
    });

    it('maps public networks to mempool.space', async () => {
      const { getBitcoinExplorerUrl } = await import('@/lib/bitcoin-wallet');
      process.env.BITCOIN_NETWORK = 'mainnet';
      expect(getBitcoinExplorerUrl()).toBe('https://mempool.space');
      process.env.BITCOIN_NETWORK = 'testnet';
      expect(getBitcoinExplorerUrl()).toBe('https://mempool.space/testnet');
      process.env.BITCOIN_NETWORK = 'signet';
      expect(getBitcoinExplorerUrl()).toBe('https://mempool.space/signet');
    });

    it('falls back to NETWORK when BITCOIN_NETWORK is unset', async () => {
      const { getBitcoinExplorerUrl } = await import('@/lib/bitcoin-wallet');
      process.env.NETWORK = 'testnet';
      expect(getBitcoinExplorerUrl()).toBe('https://mempool.space/testnet');
    });

    it('points regtest at the self-hosted explorer', async () => {
      const { getBitcoinExplorerUrl } = await import('@/lib/bitcoin-wallet');
      process.env.BITCOIN_NETWORK = 'regtest';
      expect(getBitcoinExplorerUrl()).toBe('http://localhost:3002');
    });

    it('BITCOIN_EXPLORER_URL overrides everything and strips trailing slashes', async () => {
      const { getBitcoinExplorerUrl } = await import('@/lib/bitcoin-wallet');
      process.env.BITCOIN_EXPLORER_URL = 'https://my-explorer.example///';
      expect(getBitcoinExplorerUrl()).toBe('https://my-explorer.example');
    });
  });
});
