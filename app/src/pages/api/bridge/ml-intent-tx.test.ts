import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn<typeof fetch>();

vi.mock('@/lib/step-up', () => ({
  requireStepUp: vi.fn(),
  totpFromBody: vi.fn(() => ''),
}));

vi.mock('@/lib/wallet-rpc', () => ({
  rpcCall: vi.fn(),
  WalletRpcError: class WalletRpcError extends Error {
    code: number;
    constructor(message: string, code: number) {
      super(message);
      this.code = code;
    }
  },
  nodeBestBlockHeight: vi.fn(),
}));

import { rpcCall, WalletRpcError } from '@/lib/wallet-rpc';
import { requireStepUp } from '@/lib/step-up';

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  process.env.BRIDGE_API_URL = 'https://bridge.test/api/v1/';
  vi.mocked(requireStepUp).mockClear();
  vi.mocked(rpcCall).mockClear();
  vi.mocked(requireStepUp).mockReturnValue({ ok: true });
});

afterEach(() => {
  mockFetch.mockReset();
  vi.unstubAllGlobals();
  delete process.env.BRIDGE_API_URL;
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
    const intent = '0x' + '1'.repeat(40);
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    for (const bad of ['', 'abc', '-1', '0', '1..2']) {
      // valid intent so the request passes the intent check and reaches the amount validation
      const res = await POST(makeCtx({ token_id: 't', amount: bad, intent }));
      expect(res.status).toBe(400);
    }
  });

  it('rejects non-0x intents', async () => {
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(makeCtx({ token_id: 't', amount: '1', intent: 'tmt1bad' }));
    expect(res.status).toBe(400);
  });

  it('rejects the request when 2FA step-up fails', async () => {
    mockAgentsConfig();
    vi.mocked(requireStepUp).mockReturnValue({
      ok: false,
      status: 401,
      error: 'Invalid authenticator code',
    });
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(
      makeCtx({ token_id: 'crv', amount: '1', intent: '0x1111111111111111111111111111111111111111' }),
    );
    expect(res.status).toBe(401);
    expect(vi.mocked(rpcCall)).not.toHaveBeenCalled();
  });

  it('validates the token BEFORE burning the TOTP code', async () => {
    // agents-config resolves fine, but the token is not bridged: the 400 must
    // come back without requireStepUp ever running (no burned code for a
    // knowable failure).
    mockAgentsConfig();
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(
      makeCtx({ token_id: 'unknown', amount: '1', intent: '0x' + '1'.repeat(40) }),
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(requireStepUp)).not.toHaveBeenCalled();
  });

  it('returns 400 for a token that is not bridged', async () => {
    mockAgentsConfig();
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    // valid 0x address so the request passes input validation and reaches the
    // agents-config resolution where the unknown token is rejected
    const res = await POST(makeCtx({ token_id: 'unknown', amount: '1', intent: '0x' + '1'.repeat(40) }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('token unknown is not bridged');
  });

  it('returns 503 when M2E deposits are not configured', async () => {
    const intent = '0x' + '1'.repeat(40);
    // bridged token exists, but no flavor has an m2e deposit config
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          network_type: 'testnet',
          ml_tokens: { crv: '0xdeadbeef' },
          eth_flavor_specific_config: { sepolia: { m2e: null } },
        }),
        { status: 200 },
      ),
    );
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(makeCtx({ token_id: 'crv', amount: '1', intent }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('bridge M2E deposits are not configured');
  });

  it('returns 503 when the bridge config is unreachable', async () => {
    const intent = '0x' + '1'.repeat(40);
    mockFetch.mockRejectedValueOnce(new Error('down'));
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(makeCtx({ token_id: 't', amount: '1', intent }));
    expect(res.status).toBe(503);
  });

  it('creates the intent tx via rpcCall and returns raw tx + intent', async () => {
    mockAgentsConfig();
    vi.mocked(rpcCall).mockResolvedValueOnce({ transaction: 'ff00', signed_intent: 'aa00' });
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(
      makeCtx({ token_id: 'crv', amount: '2.5', intent: '0x1111111111111111111111111111111111111111' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.raw_transaction).toBe('ff00');
    expect(body.intent).toBe('aa00');
    expect(vi.mocked(rpcCall)).toHaveBeenCalledWith(
      'token_make_tx_to_send_with_intent',
      expect.objectContaining({ token_id: 'crv', amount: '2.5' }),
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it('maps wallet RPC "insufficient funds" to a safe 400', async () => {
    const intent = '0x' + '1'.repeat(40);
    mockAgentsConfig();
    vi.mocked(rpcCall).mockRejectedValueOnce(
      new WalletRpcError('InsufficientFunds: needed 100 more', -4),
    );
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(makeCtx({ token_id: 'crv', amount: '999', intent }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    // the raw daemon message must NOT leak to the client
    expect(body.error).toBe('Insufficient funds for this transfer');
    // the code was burned before the RPC call — the UI needs to know
    expect(body.code_consumed).toBe(true);
  });

  it('maps transport failures (-32000) to a safe 503, not a user-fixable 400', async () => {
    const intent = '0x' + '1'.repeat(40);
    mockAgentsConfig();
    vi.mocked(rpcCall).mockRejectedValueOnce(
      new WalletRpcError('Cannot reach wallet-rpc-daemon at http://127.0.0.1:8456', -32000),
    );
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(makeCtx({ token_id: 'crv', amount: '1', intent }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('Wallet service unavailable');
    expect(body.code_consumed).toBe(true);
  });

  it('maps unreachable wallet RPC to a safe 503', async () => {
    const intent = '0x' + '1'.repeat(40);
    mockAgentsConfig();
    vi.mocked(rpcCall).mockRejectedValueOnce(new Error('fetch failed'));
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    // 'crv' is a bridged token so the flow reaches the wallet RPC call
    const res = await POST(makeCtx({ token_id: 'crv', amount: '1', intent }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('Wallet service unavailable');
  });

  it('returns 500 when the wallet returns an incomplete transaction', async () => {
    const intent = '0x' + '1'.repeat(40);
    mockAgentsConfig();
    vi.mocked(rpcCall).mockResolvedValueOnce({});
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(makeCtx({ token_id: 'crv', amount: '1', intent }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('wallet returned an incomplete transaction');
    expect(body.code_consumed).toBe(true);
  });

  it('maps an unopened wallet to a safe 409', async () => {
    const intent = '0x' + '1'.repeat(40);
    mockAgentsConfig();
    vi.mocked(rpcCall).mockRejectedValueOnce(new WalletRpcError('Wallet is not open', -1));
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(makeCtx({ token_id: 'crv', amount: '1', intent }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('Wallet is not open — open it from the dashboard first');
  });

  it('maps an unrecognized wallet RPC error to the generic safe 400', async () => {
    const intent = '0x' + '1'.repeat(40);
    mockAgentsConfig();
    vi.mocked(rpcCall).mockRejectedValueOnce(new WalletRpcError('exotic daemon failure', -32601));
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST(makeCtx({ token_id: 'crv', amount: '1', intent }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('Wallet rejected the bridge transaction');
  });

  it('rejects malformed JSON bodies with 400', async () => {
    const { POST } = await import('@/pages/api/bridge/ml-intent-tx');
    const res = await POST({
      request: new Request('http://localhost/api/bridge/ml-intent-tx', {
        method: 'POST',
        body: 'not-json{{',
      }),
    } as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('Invalid request body');
  });
});
