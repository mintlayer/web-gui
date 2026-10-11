import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/step-up', () => ({ verifyAndBurnTotpCode: vi.fn() }));
vi.mock('@/lib/prefs-db', () => ({ getStringPref: vi.fn() }));

import { resolveMcpSettings } from '@/lib/mcp-settings';
import { verifyAndBurnTotpCode } from '@/lib/step-up';
import { getStringPref } from '@/lib/prefs-db';

beforeEach(() => {
  vi.mocked(verifyAndBurnTotpCode).mockReset();
  vi.mocked(getStringPref).mockReset();
});

describe('resolveMcpSettings', () => {
  it('disabling requires no TOTP and clears all grants', () => {
    const d = resolveMcpSettings({ enabled: false, allowActions: true, allowSpend: true, totpCode: '' });
    expect(d).toEqual({
      ok: true,
      prefs: { 'mcp.enabled': false, 'mcp.allow_actions': false, 'mcp.allow_spend': false },
    });
    expect(verifyAndBurnTotpCode).not.toHaveBeenCalled();
  });

  it('read-only (enabled, no write grants) requires no TOTP', () => {
    const d = resolveMcpSettings({ enabled: true, allowActions: false, allowSpend: false, totpCode: '' });
    expect(d).toEqual({
      ok: true,
      prefs: { 'mcp.enabled': true, 'mcp.allow_actions': false, 'mcp.allow_spend': false },
    });
    expect(verifyAndBurnTotpCode).not.toHaveBeenCalled();
  });

  it('rejects granting actions when no 2FA secret is configured', () => {
    vi.mocked(getStringPref).mockReturnValue('');
    const d = resolveMcpSettings({ enabled: true, allowActions: true, allowSpend: false, totpCode: '123456' });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toMatch(/2FA must be configured/);
  });

  it('rejects granting spend with an invalid authenticator code', () => {
    vi.mocked(getStringPref).mockReturnValue('SECRET');
    vi.mocked(verifyAndBurnTotpCode).mockReturnValue({ ok: false, error: 'Invalid authenticator code.', reason: 'invalid' as const });
    const d = resolveMcpSettings({ enabled: true, allowActions: false, allowSpend: true, totpCode: '000000' });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toMatch(/valid authenticator code/);
  });

  it('grants actions + spend with a valid authenticator code', () => {
    vi.mocked(getStringPref).mockReturnValue('SECRET');
    vi.mocked(verifyAndBurnTotpCode).mockReturnValue({ ok: true });
    const d = resolveMcpSettings({ enabled: true, allowActions: true, allowSpend: true, totpCode: '654321' });
    expect(d).toEqual({
      ok: true,
      prefs: { 'mcp.enabled': true, 'mcp.allow_actions': true, 'mcp.allow_spend': true },
    });
    expect(verifyAndBurnTotpCode).toHaveBeenCalledWith('654321', 'SECRET', undefined);
  });

  it('never grants write access without enabled, even if the boxes are ticked', () => {
    // enabled=false forces both grants off, so no privilege is requested and no TOTP is needed.
    const d = resolveMcpSettings({ enabled: false, allowActions: true, allowSpend: true, totpCode: '' });
    expect(d.ok && d.prefs['mcp.allow_spend']).toBe(false);
  });
});
