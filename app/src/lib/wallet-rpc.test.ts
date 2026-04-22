/**
 * Tests for wallet-rpc.ts - the server-side JSON-RPC 2.0 client.
 *
 * fetch is mocked globally so no real network calls are made.
 * Tests verify: request construction, auth headers, error handling,
 * and that wrapper functions pass the correct method name and params.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Helper to build a successful mock fetch response
function mockOk(result: unknown): Response {
  return new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Helper to build an error response from the daemon (HTTP 200 with error body)
function mockRpcError(message: string, code: number): Response {
  return new Response(JSON.stringify({ error: { message, code } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Helper to build a non-ok HTTP response
function mockHttpError(status: number): Response {
  return new Response('', { status, statusText: 'Internal Server Error' });
}

describe('rpcCall - core JSON-RPC mechanics', () => {
  const mockFetch = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.resetModules();
    process.env.WALLET_RPC_URL = 'http://localhost:3034';
    process.env.WALLET_RPC_USERNAME = 'testuser';
    process.env.WALLET_RPC_PASSWORD = 'testpass';
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    mockFetch.mockReset();
    vi.unstubAllGlobals();
    delete process.env.WALLET_RPC_URL;
    delete process.env.WALLET_RPC_USERNAME;
    delete process.env.WALLET_RPC_PASSWORD;
  });

  it('sends a POST request to WALLET_RPC_URL', async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ test: true }));
    const { rpcCall } = await import('@/lib/wallet-rpc');
    await rpcCall('test_method', {});
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3034',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends the correct JSON-RPC 2.0 body', async () => {
    mockFetch.mockResolvedValueOnce(mockOk(null));
    const { rpcCall } = await import('@/lib/wallet-rpc');
    await rpcCall('wallet_info', { account: 0 });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('wallet_info');
    expect(body.params).toEqual({ account: 0 });
    expect(typeof body.id).toBe('number');
  });

  it('increments the request id on each call', async () => {
    // Use mockImplementation so each call gets a fresh Response (body can only be read once)
    mockFetch.mockImplementation(() => Promise.resolve(mockOk(null)));
    const { rpcCall } = await import('@/lib/wallet-rpc');
    await rpcCall('m1', {});
    await rpcCall('m2', {});

    const id1 = JSON.parse(mockFetch.mock.calls[0][1]!.body as string).id as number;
    const id2 = JSON.parse(mockFetch.mock.calls[1][1]!.body as string).id as number;
    expect(id2).toBeGreaterThan(id1);
  });

  it('includes a Basic Authorization header', async () => {
    mockFetch.mockResolvedValueOnce(mockOk(null));
    const { rpcCall } = await import('@/lib/wallet-rpc');
    await rpcCall('wallet_info', {});

    const [, init] = mockFetch.mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from('testuser:testpass').toString('base64')}`;
    expect(headers['Authorization']).toBe(expected);
  });

  it('returns body.result on a successful response', async () => {
    const result = { wallet_id: 'abc', account_names: [null] };
    mockFetch.mockResolvedValueOnce(mockOk(result));
    const { rpcCall } = await import('@/lib/wallet-rpc');
    const out = await rpcCall('wallet_info', {});
    expect(out).toEqual(result);
  });

  it('throws WalletRpcError(-32000) when fetch throws (network down)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connection refused'));
    const { rpcCall, WalletRpcError } = await import('@/lib/wallet-rpc');
    let caught: unknown;
    try {
      await rpcCall('wallet_info', {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WalletRpcError);
    expect((caught as { code: number }).code).toBe(-32000);
  });

  it('throws WalletRpcError with HTTP status when res.ok is false', async () => {
    mockFetch.mockResolvedValueOnce(mockHttpError(503));
    const { rpcCall, WalletRpcError } = await import('@/lib/wallet-rpc');
    const err = await rpcCall('wallet_info', {}).catch(e => e) as { code: number };
    expect(err).toBeInstanceOf(WalletRpcError);
    expect(err.code).toBe(503);
  });

  it('throws WalletRpcError from body.error when daemon returns a JSON-RPC error', async () => {
    mockFetch.mockResolvedValueOnce(mockRpcError('method not found', -32601));
    const { rpcCall, WalletRpcError } = await import('@/lib/wallet-rpc');
    const err = await rpcCall('wallet_info', {}).catch(e => e) as { message: string; code: number };
    expect(err).toBeInstanceOf(WalletRpcError);
    expect(err.message).toBe('method not found');
    expect(err.code).toBe(-32601);
  });
});

// ── Wrapper functions ─────────────────────────────────────────────────────────

describe('wrapper functions - correct method names and params', () => {
  const mockFetch = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.resetModules();
    process.env.WALLET_RPC_URL = 'http://localhost:3034';
    process.env.WALLET_RPC_USERNAME = '';
    process.env.WALLET_RPC_PASSWORD = '';
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    mockFetch.mockReset();
    vi.unstubAllGlobals();
  });

  function getLastCall() {
    const [, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    return JSON.parse(init!.body as string) as { method: string; params: Record<string, unknown> };
  }

  it('walletInfo calls "wallet_info"', async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ wallet_id: 'x', account_names: [] }));
    const { walletInfo } = await import('@/lib/wallet-rpc');
    await walletInfo();
    expect(getLastCall().method).toBe('wallet_info');
  });

  it('getBalance calls "account_balance" with utxo_states and with_locked', async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ coins: { atoms: '0', decimal: '0' }, tokens: {} }));
    const { getBalance } = await import('@/lib/wallet-rpc');
    await getBalance(0);
    const { method, params } = getLastCall();
    expect(method).toBe('account_balance');
    expect(params['utxo_states']).toEqual(['Confirmed']);
    expect(params['with_locked']).toBe('Unlocked');
    expect(params['account']).toBe(0);
  });

  it('sendToAddress wraps amount as {decimal: value}', async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ tx_id: 'txabc' }));
    const { sendToAddress } = await import('@/lib/wallet-rpc');
    await sendToAddress('addr1', '1.5', 0);
    const { method, params } = getLastCall();
    expect(method).toBe('address_send');
    expect(params['amount']).toEqual({ decimal: '1.5' });
    expect(params['address']).toBe('addr1');
    expect(params['selected_utxos']).toEqual([]);
  });

  it('startStaking calls "staking_start" with account', async () => {
    mockFetch.mockResolvedValueOnce(mockOk(null));
    const { startStaking } = await import('@/lib/wallet-rpc');
    await startStaking(0);
    const { method, params } = getLastCall();
    expect(method).toBe('staking_start');
    expect(params['account']).toBe(0);
  });

  it('stopStaking calls "staking_stop"', async () => {
    mockFetch.mockResolvedValueOnce(mockOk(null));
    const { stopStaking } = await import('@/lib/wallet-rpc');
    await stopStaking(0);
    expect(getLastCall().method).toBe('staking_stop');
  });

  it('nodeBestBlockHeight calls "node_best_block_height"', async () => {
    mockFetch.mockResolvedValueOnce(mockOk(12345));
    const { nodeBestBlockHeight } = await import('@/lib/wallet-rpc');
    const h = await nodeBestBlockHeight();
    expect(h).toBe(12345);
    expect(getLastCall().method).toBe('node_best_block_height');
  });

  it('showAddresses calls "address_show" with include_change_addresses', async () => {
    mockFetch.mockResolvedValueOnce(mockOk([]));
    const { showAddresses } = await import('@/lib/wallet-rpc');
    await showAddresses(0, true);
    const { method, params } = getLastCall();
    expect(method).toBe('address_show');
    expect(params['include_change_addresses']).toBe(true);
  });

  it('openWallet sends password as null when not provided', async () => {
    mockFetch.mockResolvedValueOnce(mockOk(null));
    const { openWallet } = await import('@/lib/wallet-rpc');
    await openWallet('/path/to/wallet');
    const { params } = getLastCall();
    expect(params['password']).toBeNull();
    expect(params['path']).toBe('/path/to/wallet');
  });

  it('createWallet sends mnemonic as null when not provided', async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ mnemonic: { type: 'NewlyGenerated', content: { mnemonic: 'word word' } } }));
    const { createWallet } = await import('@/lib/wallet-rpc');
    await createWallet('/path/wallet', true);
    const { params } = getLastCall();
    expect(params['mnemonic']).toBeNull();
    expect(params['store_seed_phrase']).toBe(true);
  });
});
