/**
 * Tests for /api/rpc - the browser-facing RPC proxy.
 *
 * Security boundary: allowlist enforcement, rate limiting, request validation.
 * The handler is a plain async function; we call it directly with a synthetic
 * Request, no Astro runtime needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ALLOWED_RPC_METHODS } from '@/lib/rpc-allowlist';

// vi.mock is hoisted before imports by Vitest
vi.mock('@/lib/wallet-rpc', () => ({
  rpcCall: vi.fn(),
  WalletRpcError: class WalletRpcError extends Error {
    code: number;
    constructor(message: string, code: number) {
      super(message);
      this.name = 'WalletRpcError';
      this.code = code;
    }
  },
}));

vi.mock('@/lib/auth', () => ({
  checkRpcRateLimit: vi.fn().mockReturnValue(true),
}));

import { POST } from '@/pages/api/rpc';
import { rpcCall, WalletRpcError } from '@/lib/wallet-rpc';
import { checkRpcRateLimit } from '@/lib/auth';

afterEach(() => {
  vi.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(body: unknown, ip = '1.2.3.4'): Request {
  return new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: JSON.stringify(body),
  });
}

async function postRpc(body: unknown, ip = '1.2.3.4') {
  const res = await POST({ request: makeReq(body, ip) } as Parameters<typeof POST>[0]);
  const json = await res.json() as Record<string, unknown>;
  return { status: res.status, json, headers: res.headers };
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe('rate limiting', () => {
  it('returns 429 when rate limit is exceeded', async () => {
    vi.mocked(checkRpcRateLimit).mockReturnValueOnce(false);
    const { status, json } = await postRpc({ method: 'wallet_info', params: {} });
    expect(status).toBe(429);
    expect(json).toMatchObject({ ok: false, error: { message: 'Rate limit exceeded' } });
  });

  it('passes the correct IP from x-forwarded-for to checkRpcRateLimit', async () => {
    vi.mocked(rpcCall).mockResolvedValueOnce({});
    await postRpc({ method: 'wallet_info', params: {} }, '10.0.0.5, 1.1.1.1');
    expect(checkRpcRateLimit).toHaveBeenCalledWith('10.0.0.5');
  });

  it('uses "unknown" when x-forwarded-for header is absent', async () => {
    vi.mocked(rpcCall).mockResolvedValueOnce({});
    const req = new Request('http://localhost/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'wallet_info', params: {} }),
    });
    await POST({ request: req } as Parameters<typeof POST>[0]);
    expect(checkRpcRateLimit).toHaveBeenCalledWith('unknown');
  });
});

// ── Request validation ────────────────────────────────────────────────────────

describe('request validation', () => {
  it('returns 400 for invalid JSON body', async () => {
    const req = new Request('http://localhost/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
      body: 'not-json',
    });
    const res = await POST({ request: req } as Parameters<typeof POST>[0]);
    const json = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(json).toMatchObject({ ok: false });
  });

  it('returns 400 when method is missing', async () => {
    const { status, json } = await postRpc({ params: {} });
    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false });
  });

  it('returns 400 when method is an empty string', async () => {
    const { status, json } = await postRpc({ method: '', params: {} });
    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false });
  });

  it('returns 400 when method is a number', async () => {
    const { status, json } = await postRpc({ method: 42, params: {} });
    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false });
  });

  it('returns 400 when method is null', async () => {
    const { status, json } = await postRpc({ method: null, params: {} });
    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false });
  });
});

// ── Allowlist enforcement ─────────────────────────────────────────────────────

// Derive the test list from the canonical allowlist so they stay in sync
const ALLOWED_METHODS = [...ALLOWED_RPC_METHODS];

describe('allowlist enforcement - allowed methods', () => {
  beforeEach(() => {
    vi.mocked(rpcCall).mockResolvedValue({ foo: 'bar' });
  });

  it.each(ALLOWED_METHODS)('allows method "%s"', async (method) => {
    const { status, json } = await postRpc({ method, params: {} });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true });
  });
});

describe('allowlist enforcement - blocked methods', () => {
  it.each([
    'wallet_delete',
    'admin_shutdown',
    'node_shutdown',
    '../../etc/passwd',
    '__proto__',
    'constructor',
    'WALLET_INFO', // case-sensitive - uppercase not allowed
    'open_wallet',             // old wrong name — must be blocked
    'create_wallet',           // old wrong name — must be blocked
    'wallet_open',             // server-side only — must not be callable via proxy
    'wallet_create',           // server-side only — must not be callable via proxy
    'wallet_show_seed_phrase', // sensitive — server-side only
    'wallet_unlock_private_keys', // sensitive — server-side only
  ])('blocks method "%s"', async (method) => {
    const { status, json } = await postRpc({ method, params: {} });
    expect(status).toBe(403);
    expect(json).toMatchObject({ ok: false });
  });
});

// ── Params normalization ──────────────────────────────────────────────────────

describe('params normalization', () => {
  beforeEach(() => {
    vi.mocked(rpcCall).mockResolvedValue(null);
  });

  it('passes {} to rpcCall when params is null', async () => {
    await postRpc({ method: 'wallet_info', params: null });
    expect(rpcCall).toHaveBeenCalledWith('wallet_info', {});
  });

  it('passes {} to rpcCall when params is an array', async () => {
    await postRpc({ method: 'wallet_info', params: [1, 2, 3] });
    expect(rpcCall).toHaveBeenCalledWith('wallet_info', {});
  });

  it('passes {} to rpcCall when params is omitted', async () => {
    await postRpc({ method: 'wallet_info' });
    expect(rpcCall).toHaveBeenCalledWith('wallet_info', {});
  });

  it('passes the params object through when valid', async () => {
    const params = { account: 0, foo: 'bar' };
    await postRpc({ method: 'wallet_info', params });
    expect(rpcCall).toHaveBeenCalledWith('wallet_info', params);
  });
});

// ── Success path ──────────────────────────────────────────────────────────────

describe('success path', () => {
  it('returns {ok: true, result} with status 200', async () => {
    const mockResult = { wallet_id: 'w1', account_names: [null] };
    vi.mocked(rpcCall).mockResolvedValueOnce(mockResult);
    const { status, json } = await postRpc({ method: 'wallet_info', params: {} });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, result: mockResult });
  });

  it('returns Content-Type: application/json on success', async () => {
    vi.mocked(rpcCall).mockResolvedValueOnce({});
    const { headers } = await postRpc({ method: 'wallet_info', params: {} });
    expect(headers.get('Content-Type')).toBe('application/json');
  });
});

// ── Error paths ───────────────────────────────────────────────────────────────

describe('error paths', () => {
  it('returns 502 with {ok: false, error} on WalletRpcError', async () => {
    vi.mocked(rpcCall).mockRejectedValueOnce(new WalletRpcError('daemon error', -32601));
    const { status, json } = await postRpc({ method: 'wallet_info', params: {} });
    expect(status).toBe(502);
    expect(json).toMatchObject({ ok: false, error: { message: 'daemon error', code: -32601 } });
  });

  it('returns 502 with code -1 on generic Error', async () => {
    vi.mocked(rpcCall).mockRejectedValueOnce(new Error('unexpected'));
    const { status, json } = await postRpc({ method: 'wallet_info', params: {} });
    expect(status).toBe(502);
    expect(json).toMatchObject({ ok: false, error: { code: -1 } });
  });

  it('does not leak internal error messages from generic errors', async () => {
    vi.mocked(rpcCall).mockRejectedValueOnce(new Error('connect ECONNREFUSED wallet-rpc-daemon:3034'));
    const { json } = await postRpc({ method: 'wallet_info', params: {} });
    const error = (json as { error: { message: string } }).error;
    expect(error.message).not.toContain('wallet-rpc-daemon');
    expect(error.message).not.toContain('ECONNREFUSED');
    expect(error.message).toBe('An internal error occurred');
  });

  it('returns Content-Type: application/json on error responses', async () => {
    vi.mocked(rpcCall).mockRejectedValueOnce(new Error('fail'));
    const { headers } = await postRpc({ method: 'wallet_info', params: {} });
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('returns Content-Type: application/json on 400 validation errors', async () => {
    const { headers } = await postRpc({ method: '', params: {} });
    expect(headers.get('Content-Type')).toBe('application/json');
  });
});
