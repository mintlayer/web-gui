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
import { POST } from './stake-trade';

beforeEach(() => {
  vi.mocked(requireStepUp).mockClear();
  vi.mocked(rpcCall).mockClear();
  vi.mocked(requireStepUp).mockReturnValue({ ok: true });
});

const ADDR = 'ml1qsometestaddress0000000000000000000000000';
const ID = 'mmltk1q0000000000000000000000000000000000000';

const VALID: Record<string, Record<string, unknown>> = {
  delegation_create: { account: 0, pool_id: ID, address: ADDR, options: {} },
  delegation_stake: { account: 0, delegation_id: ID, amount: { decimal: '10.5' }, options: {} },
  delegation_withdraw: { account: 0, delegation_id: ID, amount: { decimal: '1' }, address: ADDR, options: {} },
  staking_sweep_delegation: { account: 0, delegation_id: ID, destination_address: ADDR, options: {} },
  staking_create_pool: {
    account: 0,
    amount: { decimal: '1000' },
    cost_per_block: { decimal: '0' },
    margin_ratio_per_thousand: '50',
    decommission_address: ADDR,
    staker_address: null,
    vrf_public_key: null,
    options: {},
  },
  staking_decommission_pool: { account: 0, pool_id: ID, output_address: null, options: {} },
  order_create: {
    account: 0,
    give: { type: 'Coin', content: { amount: { decimal: '1.5' } } },
    ask: { type: 'Token', content: { id: ID, amount: { atoms: '1' } } },
    conclude_address: ADDR,
    options: {},
  },
  order_fill: {
    account: 0,
    order_id: ID,
    fill_amount_in_ask_currency: { decimal: '0.5' },
    output_address: null,
    options: {},
  },
  order_conclude: { account: 0, order_id: ID, options: {} },
};

function req(body: unknown): Request {
  return new Request('http://localhost/api/stake-trade', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function ctx(body: unknown) {
  return { request: req(body) } as never;
}

describe('stake-trade endpoint', () => {
  it('rejects unknown actions without burning the code', async () => {
    const res = await POST(ctx({ action: 'address_sweep_spendable', params: {} }));
    expect(res.status).toBe(400);
    expect(requireStepUp).not.toHaveBeenCalled();
  });

  it('rejects batches over the size cap', async () => {
    const actions = Array.from({ length: 6 }, () => ({ action: 'order_conclude', params: VALID.order_conclude }));
    const res = await POST(ctx({ actions, totp_code: '654321' }));
    expect(res.status).toBe(400);
    expect(requireStepUp).not.toHaveBeenCalled();
  });

  const INVALID_CASES: Array<[string, Record<string, unknown>, string]> = [
    ['delegation_create', { ...VALID.delegation_create, pool_id: 'short' }, 'pool_id'],
    ['delegation_create', { ...VALID.delegation_create, address: null }, 'address'],
    ['delegation_stake', { ...VALID.delegation_stake, amount: { decimal: '-1' } }, 'amount'],
    ['delegation_stake', { ...VALID.delegation_stake, amount: '10' }, 'amount'],
    ['delegation_withdraw', { ...VALID.delegation_withdraw, address: 'DROP TABLE' }, 'address'],
    ['staking_sweep_delegation', { ...VALID.staking_sweep_delegation, destination_address: 42 }, 'destination_address'],
    ['staking_create_pool', { ...VALID.staking_create_pool, margin_ratio_per_thousand: '0' }, 'margin_ratio'],
    ['staking_create_pool', { ...VALID.staking_create_pool, margin_ratio_per_thousand: '2000' }, 'margin_ratio'],
    ['staking_create_pool', { ...VALID.staking_create_pool, staker_address: ADDR }, 'staker_address'],
    ['staking_create_pool', { ...VALID.staking_create_pool, cost_per_block: { decimal: '-1' } }, 'cost_per_block'],
    ['staking_decommission_pool', { ...VALID.staking_decommission_pool, output_address: ADDR }, 'output_address'],
    ['order_create', { ...VALID.order_create, give: { type: 'Coin', content: { amount: { decimal: 'abc' } } } }, 'give'],
    ['order_create', { ...VALID.order_create, ask: { type: 'Token', content: { id: 'x' } } }, 'ask'],
    ['order_create', { ...VALID.order_create, conclude_address: null }, 'conclude_address'],
    ['order_fill', { ...VALID.order_fill, order_id: '../etc/passwd' }, 'order_id'],
    ['order_fill', { ...VALID.order_fill, fill_amount_in_ask_currency: { decimal: '0' } }, 'fill'],
    ['order_conclude', { ...VALID.order_conclude, account: 1 }, 'account'],
  ];

  it.each(INVALID_CASES)('rejects invalid params for %s without burning the code', async (action, params, _why) => {
    const res = await POST(ctx({ action, params, totp_code: '654321' }));
    expect(res.status).toBe(400);
    expect(requireStepUp).not.toHaveBeenCalled();
  });

  it('executes a single action end to end', async () => {
    vi.mocked(rpcCall).mockResolvedValue({ tx_id: 'abc123' });
    const res = await POST(ctx({ action: 'delegation_stake', params: VALID.delegation_stake, totp_code: '654321' }));
    expect(res.status).toBe(200);
    expect(rpcCall).toHaveBeenCalledWith('delegation_stake', VALID.delegation_stake);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.results).toEqual([{ tx_id: 'abc123' }]);
  });

  it('executes a batch with a single burn', async () => {
    vi.mocked(rpcCall)
      .mockResolvedValueOnce({ delegation_id: ID, tx_id: 't1' })
      .mockResolvedValueOnce({ tx_id: 't2' });
    const res = await POST(ctx({
      actions: [
        { action: 'delegation_create', params: VALID.delegation_create },
        { action: 'delegation_stake', params: VALID.delegation_stake },
      ],
      totp_code: '654321',
    }));
    expect(res.status).toBe(200);
    expect(requireStepUp).toHaveBeenCalledTimes(1);
    expect(rpcCall).toHaveBeenCalledTimes(2);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.results.map((r: { tx_id: string }) => r.tx_id)).toEqual(['t1', 't2']);
  });

  it('flags code_consumed when the daemon rejects after the burn', async () => {
    vi.mocked(rpcCall).mockRejectedValue(
      new WalletRpcError('Cannot reach wallet-rpc-daemon at http://127.0.0.1:8556 — is it running?', -32000),
    );
    const res = await POST(ctx({ action: 'order_fill', params: VALID.order_fill, totp_code: '654321' }));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.code_consumed).toBe(true);
    expect(data.error).not.toContain('127.0.0.1');
  });

  it('returns a generic 500 (no internals) for unexpected errors', async () => {
    vi.mocked(rpcCall).mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:8556'));
    const res = await POST(ctx({ action: 'order_conclude', params: VALID.order_conclude, totp_code: '654321' }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Operation failed');
    expect(data.code_consumed).toBe(true);
    expect(JSON.stringify(data)).not.toContain('10.1.2.3');
  });

  it('passes step-up failures through (429/401)', async () => {
    vi.mocked(requireStepUp).mockReturnValue({ ok: false, error: 'Too many requests. Try again in a minute.', status: 429 });
    const res = await POST(ctx({ action: 'delegation_stake', params: VALID.delegation_stake, totp_code: '654321' }));
    expect(res.status).toBe(429);
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it('requires a TOTP code', async () => {
    vi.mocked(requireStepUp).mockReturnValue({ ok: false, error: 'Authentication code required', status: 401 });
    const res = await POST(ctx({ action: 'delegation_stake', params: VALID.delegation_stake }));
    expect(res.status).toBe(401);
    expect(rpcCall).not.toHaveBeenCalled();
  });
});
