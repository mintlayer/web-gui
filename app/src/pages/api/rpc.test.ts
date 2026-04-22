/**
 * Tests for /api/rpc - the browser-facing RPC proxy.
 *
 * Security boundary: allowlist enforcement, rate limiting, request validation.
 * The handler is a plain async function; we call it directly with a synthetic
 * Request, no Astro runtime needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// These are all the methods in ALLOWED_METHODS (copied from rpc.ts)
const ALLOWED_METHODS = [
  'node_best_block_height',
  'node_chainstate_info',
  'account_balance',
  'address_new',
  'address_show',
  'address_send',
  'staking_status',
  'staking_start',
  'staking_stop',
  'staking_list_pools',
  'staking_list_created_block_ids',
  'staking_decommission_pool',
  'staking_create_pool',
  'delegation_list_ids',
  'delegation_create',
  'delegation_stake',
  'delegation_withdraw',
  'staking_sweep_delegation',
  'wallet_info',
  'wallet_best_block',
  'open_wallet',
  'create_wallet',
  'node_get_tokens_info',
  'token_send',
  'token_issue_new',
  'token_nft_issue_new',
  'token_mint',
  'token_unmint',
  'token_lock_supply',
  'token_freeze',
  'token_unfreeze',
  'token_change_authority',
  'token_change_metadata_uri',
  'order_list_own',
  'order_list_all_active',
  'order_create',
  'order_fill',
  'order_conclude',
  'order_freeze',
  'wallet_show_seed_phrase',
  'wallet_lock_private_keys',
  'wallet_unlock_private_keys',
  'wallet_set_lookahead_size',
  'transaction_list_by_address',
  'transaction_list_pending',
  'account_utxos',
];

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
