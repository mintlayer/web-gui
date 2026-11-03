import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
}));
vi.mock('@/lib/prefs-db', () => ({
  getStringPref: vi.fn(),
  getPref: vi.fn(),
  setPref: vi.fn(),
}));

import {
  resolvePasswordChange,
  applyPasswordChange,
  isPasswordChangeThrottled,
  resetPasswordChangeThrottle,
} from '@/lib/password-change';
import { verifyPassword, hashPassword } from '@/lib/auth';
import { getStringPref, getPref, setPref } from '@/lib/prefs-db';

const mockVerify = vi.mocked(verifyPassword);
const mockHash = vi.mocked(hashPassword);
const mockGetStringPref = vi.mocked(getStringPref);
const mockGetPref = vi.mocked(getPref);

beforeEach(() => {
  mockVerify.mockReset();
  mockHash.mockReset();
  mockGetStringPref.mockReset();
  mockGetPref.mockReset();
  resetPasswordChangeThrottle();
});

describe('resolvePasswordChange', () => {
  const valid = { currentPassword: 'old-pass', newPassword: 'new-password-1', confirmPassword: 'new-password-1' };

  it('returns the new hash when everything is valid', async () => {
    mockGetStringPref.mockReturnValue('stored-hash');
    mockVerify.mockResolvedValue(true);
    mockHash.mockResolvedValue('new-hash');
    const d = await resolvePasswordChange(valid);
    expect(d).toEqual({ ok: true, newHash: 'new-hash' });
  });

  it('rejects when no password is configured (400)', async () => {
    mockGetStringPref.mockReturnValue('');
    const d = await resolvePasswordChange(valid);
    expect(d).toMatchObject({ ok: false, httpStatus: 400 });
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('rejects a wrong current password (401)', async () => {
    mockGetStringPref.mockReturnValue('stored-hash');
    mockVerify.mockResolvedValue(false);
    const d = await resolvePasswordChange(valid);
    expect(d).toMatchObject({ ok: false, error: 'Current password is incorrect', httpStatus: 401 });
  });

  it('rejects a too-short new password (400)', async () => {
    mockGetStringPref.mockReturnValue('stored-hash');
    mockVerify.mockResolvedValue(true);
    const d = await resolvePasswordChange({ ...valid, newPassword: 'short', confirmPassword: 'short' });
    expect(d).toMatchObject({ ok: false, httpStatus: 400 });
  });

  it('rejects mismatched confirmation (400)', async () => {
    mockGetStringPref.mockReturnValue('stored-hash');
    mockVerify.mockResolvedValue(true);
    const d = await resolvePasswordChange({ ...valid, confirmPassword: 'different' });
    expect(d).toMatchObject({ ok: false, error: 'New passwords do not match', httpStatus: 400 });
  });

  it('locks out after 5 wrong current passwords for the same key', async () => {
    mockGetStringPref.mockReturnValue('stored-hash');
    mockVerify.mockResolvedValue(false);
    for (let i = 0; i < 5; i++) {
      await resolvePasswordChange(valid, '1.2.3.4');
    }
    const d = await resolvePasswordChange(valid, '1.2.3.4');
    expect(d).toMatchObject({ ok: false, httpStatus: 429 });
    expect(isPasswordChangeThrottled('1.2.3.4')).toBe(true);
    // A correct password no longer bypasses the lockout.
    mockVerify.mockResolvedValue(true);
    const ok = await resolvePasswordChange(valid, '1.2.3.4');
    expect(ok).toMatchObject({ ok: false, httpStatus: 429 });
  });

  it('does not count failures for other keys', async () => {
    mockGetStringPref.mockReturnValue('stored-hash');
    mockVerify.mockResolvedValue(false);
    await resolvePasswordChange(valid, '1.1.1.1');
    expect(isPasswordChangeThrottled('2.2.2.2')).toBe(false);
  });

  it('clears the failure count after a successful change', async () => {
    mockGetStringPref.mockReturnValue('stored-hash');
    mockVerify.mockResolvedValue(false);
    await resolvePasswordChange(valid, '1.2.3.4');
    mockVerify.mockResolvedValue(true);
    mockHash.mockResolvedValue('new-hash');
    await resolvePasswordChange(valid, '1.2.3.4');
    expect(isPasswordChangeThrottled('1.2.3.4')).toBe(false);
  });

  it('skips throttling when no key is supplied', async () => {
    mockGetStringPref.mockReturnValue('stored-hash');
    mockVerify.mockResolvedValue(false);
    for (let i = 0; i < 10; i++) {
      const d = await resolvePasswordChange(valid);
      expect(d).toMatchObject({ httpStatus: 401 });
    }
  });
});

describe('applyPasswordChange', () => {
  it('stores the new hash and bumps the session version', () => {
    mockGetPref.mockReturnValue(2);
    applyPasswordChange('new-hash');
    expect(setPref).toHaveBeenCalledWith('auth.password_hash', 'new-hash');
    expect(setPref).toHaveBeenCalledWith('auth.session_version', 3);
  });

  it('treats a missing session version as 0', () => {
    mockGetPref.mockReturnValue(undefined);
    applyPasswordChange('new-hash');
    expect(setPref).toHaveBeenCalledWith('auth.session_version', 1);
  });
});
