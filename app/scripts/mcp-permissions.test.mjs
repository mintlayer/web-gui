import { describe, it, expect } from 'vitest';
import { METHOD_TIERS, checkMethodAccess } from './mcp-permissions.mjs';

const off = { enabled: false, allowActions: false, allowSpend: false };
const readOnly = { enabled: true, allowActions: false, allowSpend: false };
const withActions = { enabled: true, allowActions: true, allowSpend: false };
const full = { enabled: true, allowActions: true, allowSpend: true };

describe('checkMethodAccess', () => {
  it('denies everything when MCP is disabled', () => {
    expect(checkMethodAccess('account_balance', off)).toMatch(/disabled/);
  });

  it('allows read methods when enabled', () => {
    expect(checkMethodAccess('account_balance', readOnly)).toBeNull();
    expect(checkMethodAccess('transaction_list_by_address', readOnly)).toBeNull();
  });

  it('gates action methods behind allowActions', () => {
    expect(checkMethodAccess('staking_start', readOnly)).toMatch(/actions/);
    expect(checkMethodAccess('staking_start', withActions)).toBeNull();
  });

  it('gates spend methods behind allowSpend', () => {
    expect(checkMethodAccess('address_send', withActions)).toMatch(/[Ff]und/);
    expect(checkMethodAccess('address_send', full)).toBeNull();
  });

  it('denies unknown methods even with full permissions', () => {
    expect(checkMethodAccess('wallet_show_seed_phrase', full)).toMatch(/not available/);
    expect(checkMethodAccess('wallet_open', full)).toMatch(/not available/);
    expect(checkMethodAccess('nonexistent_method', full)).toMatch(/not available/);
  });

  it('does not treat inherited Object.prototype keys as methods', () => {
    for (const m of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(checkMethodAccess(m, full)).toMatch(/not available/);
    }
  });

  it('never exposes sensitive methods in the tier map', () => {
    for (const m of ['wallet_show_seed_phrase', 'wallet_unlock_private_keys', 'wallet_open', 'wallet_create', 'wallet_recover']) {
      expect(METHOD_TIERS[m]).toBeUndefined();
    }
  });
});
