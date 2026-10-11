import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  process.env.BRIDGE_API_URL = 'https://bridge.test/api/v1/';
  process.env.WALLET_RPC_URL = 'http://wallet-rpc:3034';
  process.env.WALLET_RPC_USERNAME = 'w';
  process.env.WALLET_RPC_PASSWORD = 'p';
});

afterEach(() => {
  mockFetch.mockReset();
  vi.unstubAllGlobals();
  delete process.env.BRIDGE_API_URL;
  delete process.env.WALLET_RPC_URL;
  delete process.env.WALLET_RPC_USERNAME;
  delete process.env.WALLET_RPC_PASSWORD;
});

const CONFIG = {
  network_type: 'testnet',
  ml_tokens: { crv: '0xdeadbeef' },
  eth_flavor_specific_config: {
    sepolia: { m2e: { deposit_tx_destination: 'tmt1deposit' } },
  },
};

function mockAgentsConfig() {
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(CONFIG), { status: 200 }));
}

function makeCtx(body: unknown) {
  return {
    request: new Request('http://localhost/api/bridge/ml-intent-tx', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  } as never;
}

describe('POST /api/bridge/ml-intent-tx', () => {
  it('returns 400 when required fields are missing', async () => {
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    for (const body of [{}, { token_id: 't' }, { token_id: 't', amount: '1' }, { token_id: 't', amount: '1', intent: 'nothex' }]) {
      const res = await POST(makeCtx(body));
      expect(res.status).toBe(400);
    }
  });

  it('rejects invalid amounts', async () => {
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    for (const bad of ['-1', 'abc', '0', '1.234567890123']) {
      const res = await POST(makeCtx({ token_id: 't', amount: bad, intent: '0xabc' }));
      expect(res.status).toBe(400);
    }
  });

  it('rejects non-0x intents', async () => {
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(makeCtx({ token_id: 'crv', amount: '1', intent: 'tmt1bad' }));
    expect(res.status).toBe(400);
  });

  it('rejects unsupported tokens', async () => {
    mockAgentsConfig();
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(makeCtx({ token_id: 'unknown', amount: '1', intent: '0xabc' }));
    expect(res.status).toBe(400);
  });

  it('returns 503 when the bridge config is unreachable', async () => {
    const intent = '0x' + '1'.repeat(40);
    mockFetch.mockRejectedValueOnce(new Error('down'));
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(makeCtx({ token_id: 't', amount: '1', intent }));
    expect(res.status).toBe(503);
  });

  it('creates the intent tx and returns raw tx + intent', async () => {
    mockAgentsConfig();
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { transaction: 'ff00', signed_intent: 'aa00' } }),
        { status: 200 },
      ),
    );
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(
      makeCtx({ token_id: 'crv', amount: '2.5', intent: '0x1111111111111111111111111111111111111111' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.raw_transaction).toBe('ff00');
    expect(body.intent).toBe('aa00');
  });

  it('maps wallet RPC errors to 400', async () => {
    const intent = '0x' + '1'.repeat(40);
    mockAgentsConfig();
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: -4, message: 'insufficient funds' } }),
        { status: 200 },
      ),
    );
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(makeCtx({ token_id: 'crv', amount: '999', intent }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('insufficient funds');
  });
});
