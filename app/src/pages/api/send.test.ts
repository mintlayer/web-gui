import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';

vi.mock('@/lib/wallet-rpc', () => ({
  WalletRpcError: class WalletRpcError extends Error {
    code: number;
    constructor(message: string, code: number) {
      super(message);
      this.code = code;
    }
  },
  rpcCall: vi.fn(),
}));

vi.mock('@/lib/step-up', () => ({
  requireStepUp: vi.fn(),
  totpFromBody: vi.fn((body: unknown) => {
    const rec = body as Record<string, unknown>;
    return typeof rec?.totp_code === 'string' ? rec.totp_code : '';
  }),
}));

vi.mock('@/lib/prefs-db', () => ({
  openPrefsDb: vi.fn().mockResolvedValue({}),
}));

import { POST } from './send';
import { rpcCall } from '@/lib/wallet-rpc';
import { requireStepUp } from '@/lib/step-up';

const mockRpcCall = vi.mocked(rpcCall);
const mockRequireStepUp = vi.mocked(requireStepUp);

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeContext(request: Request): APIContext {
  return { request, clientAddress: '1.2.3.4' } as unknown as APIContext;
}

const validBody = {
  address: 'mtc1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjkzs',
  amount: '1.5',
  asset_type: 'ml',
  totp_code: '123456',
};

describe('POST /api/send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireStepUp.mockReturnValue({ ok: true });
    mockRpcCall.mockResolvedValue({ tx_id: 'abc123' });
  });

  it('sends ML coins via address_send after successful step-up', async () => {
    const res = await POST(makeContext(makeRequest(validBody)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, tx_id: 'abc123' });
    expect(mockRpcCall).toHaveBeenCalledWith(
      'address_send',
      expect.objectContaining({ address: validBody.address }),
    );
  });

  it('sends tokens via token_send when asset_type is token', async () => {
    const res = await POST(
      makeContext(
        makeRequest({ ...validBody, asset_type: 'token', token_id: 'deadbeef' }),
      ),
    );
    expect(res.status).toBe(200);
    expect(mockRpcCall).toHaveBeenCalledWith(
      'token_send',
      expect.objectContaining({ token_id: 'deadbeef' }),
    );
  });

  it('rejects missing address', async () => {
    const res = await POST(makeContext(makeRequest({ ...validBody, address: '' })));
    expect(res.status).toBe(400);
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it('rejects invalid amounts before touching step-up', async () => {
    for (const amount of ['', 'abc', '-1', '0', '1.1234567891', '1e5']) {
      const res = await POST(makeContext(makeRequest({ ...validBody, amount })));
      expect(res.status).toBe(400);
    }
    expect(mockRequireStepUp).not.toHaveBeenCalled();
  });

  it('rejects token sends without token_id', async () => {
    const res = await POST(makeContext(makeRequest({ ...validBody, asset_type: 'token' })));
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON bodies', async () => {
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: 'not-json',
    });
    const res = await POST(makeContext(req));
    expect(res.status).toBe(400);
  });

  it('enforces TOTP step-up and returns its status', async () => {
    mockRequireStepUp.mockReturnValue({ ok: false, status: 401, error: 'Invalid code' });
    const res = await POST(makeContext(makeRequest(validBody)));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid code');
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it('maps wallet RPC errors to 502 with the daemon message', async () => {
    const { WalletRpcError } = await import('@/lib/wallet-rpc');
    mockRpcCall.mockRejectedValue(new WalletRpcError('Insufficient funds', -1));
    const res = await POST(makeContext(makeRequest(validBody)));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('Insufficient funds');
  });
});
