import { describe, it, expect, vi, beforeEach } from 'vitest';

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
}));

import { rpcCall, WalletRpcError } from '@/lib/wallet-rpc';
import { requireStepUp } from '@/lib/step-up';

beforeEach(() => {
  vi.mocked(requireStepUp).mockClear();
  vi.mocked(rpcCall).mockClear();
  vi.mocked(requireStepUp).mockReturnValue({ ok: true });
});

const TOTP = { totp_code: '654321' };

const VALID = {
  issue: {
    account: 0,
    destination_address: 'ml1qsometestaddress0000000000000000000000000',
    metadata: {
      token_ticker: 'MYTKN',
      number_of_decimals: 6,
      metadata_uri: '',
      token_supply: { type: 'Unlimited' },
      is_freezable: true,
    },
    options: {},
  },
  issue_nft: {
    account: 0,
    destination_address: 'ml1qsometestaddress0000000000000000000000000',
    metadata: {
      media_hash: 'a'.repeat(32),
      name: 'Test NFT',
      description: null,
      ticker: 'TNFT',
      creator: null,
      icon_uri: { hex: '68747470733a2f2f6578616d706c65' },
      media_uri: null,
      additional_metadata_uri: null,
    },
    options: {},
  },
  mint: {
    account: 0,
    token_id: 'mmltk1q0000000000000000000000000000000000000',
    address: 'ml1qsometestaddress0000000000000000000000000',
    amount: { decimal: '10.5' },
    options: {},
  },
  unmint: {
    account: 0,
    token_id: 'mmltk1q0000000000000000000000000000000000000',
    amount: { decimal: '1' },
    options: {},
  },
  lock: { account_index: 0, token_id: 'mmltk1q0000000000000000000000000000000000000', options: {} },
  freeze: {
    account: 0,
    token_id: 'mmltk1q0000000000000000000000000000000000000',
    is_unfreezable: false,
    options: {},
  },
  unfreeze: { account: 0, token_id: 'mmltk1q0000000000000000000000000000000000000', options: {} },
  authority: {
    account: 0,
    token_id: 'mmltk1q0000000000000000000000000000000000000',
    address: 'ml1qsometestaddress0000000000000000000000000',
    options: {},
  },
  metaUri: {
    account: 0,
    token_id: 'mmltk1q0000000000000000000000000000000000000',
    metadata_uri: { hex: '2f697066732f616263' },
    options: {},
  },
} as const;

function makeCtx(body: unknown) {
  return {
    request: new Request('http://localhost/api/token-manage', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  } as never;
}

describe('POST /api/token-manage', () => {
  it('returns 400 for an unknown action', async () => {
    const { POST } = await import('@/pages/api/token-manage');
    const res = await POST(makeCtx({ action: 'token_mint_all', params: {}, ...TOTP }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it('rejects invalid params per action WITHOUT burning the TOTP code', async () => {
    const { POST } = await import('@/pages/api/token-manage');
    const cases = [
      { action: 'token_mint', params: { ...VALID.mint, amount: { decimal: '-1' } } },
      { action: 'token_mint', params: { ...VALID.mint, token_id: 'short' } },
      { action: 'token_issue_new', params: { ...VALID.issue, metadata: { ...VALID.issue.metadata, token_ticker: 'TOOLONGTICKER' } } },
      { action: 'token_issue_new', params: { ...VALID.issue, metadata: { ...VALID.issue.metadata, number_of_decimals: 19 } } },
      { action: 'token_issue_new', params: { ...VALID.issue, metadata: { ...VALID.issue.metadata, is_freezable: 'yes' } } },
      { action: 'token_freeze', params: { ...VALID.freeze, is_unfreezable: 'nope' } },
      { action: 'token_change_authority', params: { ...VALID.authority, address: '!!!' } },
      { action: 'token_change_metadata_uri', params: { ...VALID.metaUri, metadata_uri: { hex: 5 } } },
      { action: 'token_nft_issue_new', params: { ...VALID.issue_nft, metadata: { ...VALID.issue_nft.metadata, creator: '0x1' } } },
      { action: 'token_unmint', params: { ...VALID.unmint, amount: { decimal: 'abc' } } },
      { action: 'token_lock_supply', params: { ...VALID.lock, account_index: 1 } },
      { action: 'token_unfreeze', params: { ...VALID.unfreeze, token_id: undefined } },
    ];
    for (const c of cases) {
      const res = await POST(makeCtx({ ...c, ...TOTP }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false });
    }
    expect(requireStepUp).not.toHaveBeenCalled();
  });

  it('performs a mint when step-up passes', async () => {
    const { POST } = await import('@/pages/api/token-manage');
    vi.mocked(rpcCall).mockResolvedValue({ tx_id: '0xtx' });
    const res = await POST(makeCtx({ action: 'token_mint', params: VALID.mint, ...TOTP }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, result: { tx_id: '0xtx' } });
    expect(rpcCall).toHaveBeenCalledWith('token_mint', VALID.mint);
    expect(requireStepUp).toHaveBeenCalledTimes(1);
  });

  it('flags code_consumed on daemon rejection (502)', async () => {
    const { POST } = await import('@/pages/api/token-manage');
    vi.mocked(rpcCall).mockRejectedValue(
      new WalletRpcError('not enough funds', -32005),
    );
    const res = await POST(makeCtx({ action: 'token_mint', params: VALID.mint, ...TOTP }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, code_consumed: true, error: 'not enough funds' });
  });

  it('redacts transport-class daemon errors (no URL leak)', async () => {
    const { POST } = await import('@/pages/api/token-manage');
    vi.mocked(rpcCall).mockRejectedValue(
      new WalletRpcError('Cannot reach wallet-rpc-daemon at http://127.0.0.1:8556 — is it running?', -32000),
    );
    const res = await POST(makeCtx({ action: 'token_mint', params: VALID.mint, ...TOTP }));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.code_consumed).toBe(true);
    expect(data.error).not.toContain('127.0.0.1');
    expect(data.error).toContain('wallet service is unavailable');
  });

  it('flags code_consumed with a generic message on unexpected errors (500)', async () => {
    const { POST } = await import('@/pages/api/token-manage');
    vi.mocked(rpcCall).mockRejectedValue(new Error('connect ECONNREFUSED http://127.0.0.1:8256'));
    const res = await POST(makeCtx({ action: 'token_mint', params: VALID.mint, ...TOTP }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string; code_consumed: boolean };
    expect(body.ok).toBe(false);
    expect(body.code_consumed).toBe(true);
    expect(body.error).not.toContain('127.0.0.1');
    expect(body.error).not.toContain('8256');
  });

  it('passes through step-up failures (429 throttled)', async () => {
    const { POST } = await import('@/pages/api/token-manage');
    vi.mocked(requireStepUp).mockReturnValue({
      ok: false,
      error: 'Too many attempts. Try again in 15 minutes.',
      status: 429,
    });
    const res = await POST(makeCtx({ action: 'token_mint', params: VALID.mint, ...TOTP }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it('requires a totp_code', async () => {
    const { POST } = await import('@/pages/api/token-manage');
    vi.mocked(requireStepUp).mockReturnValue({
      ok: false,
      error: '2FA code required',
      status: 401,
    });
    const res = await POST(makeCtx({ action: 'token_mint', params: VALID.mint }));
    expect(res.status).toBe(401);
  });
});
