import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyTOTP: vi.fn(),
  checkRpcRateLimit: vi.fn(),
  getClientAddress: vi.fn(() => '127.0.0.1'),
  getStringPref: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyTOTP: mocks.verifyTOTP,
  checkRpcRateLimit: mocks.checkRpcRateLimit,
  getClientAddress: mocks.getClientAddress,
}));
vi.mock('@/lib/prefs-db', () => ({
  getStringPref: mocks.getStringPref,
}));

import { requireStepUp, totpFromBody, verifyAndBurnTotpCode, isTotpThrottled } from '@/lib/step-up';

const REQ = new Request('http://localhost/api/test', { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getClientAddress.mockReturnValue('127.0.0.1');
  mocks.checkRpcRateLimit.mockReturnValue(true);
  mocks.getStringPref.mockReturnValue('SECRETBASE32');
});

describe('requireStepUp', () => {
  it('rejects when rate limited', () => {
    mocks.checkRpcRateLimit.mockReturnValue(false);
    expect(requireStepUp('123456', REQ)).toMatchObject({ ok: false, status: 429 });
  });

  it('rejects when 2FA is not configured', () => {
    mocks.getStringPref.mockReturnValue(null);
    expect(requireStepUp('123456', REQ)).toMatchObject({ ok: false, status: 409 });
  });

  it('rejects an invalid code', () => {
    mocks.verifyTOTP.mockReturnValue(false);
    expect(requireStepUp('000000', REQ)).toMatchObject({ ok: false, status: 401 });
  });

  it('accepts a valid code once', () => {
    mocks.verifyTOTP.mockReturnValue(true);
    expect(requireStepUp('123456', REQ)).toEqual({ ok: true });
  });

  it('rejects replay of the same code within the window', () => {
    mocks.verifyTOTP.mockReturnValue(true);
    expect(requireStepUp('445566', REQ)).toEqual({ ok: true });
    expect(requireStepUp('445566', REQ)).toMatchObject({ ok: false, status: 401 });
  });

  it('allows different codes after a replay rejection', () => {
    mocks.verifyTOTP.mockReturnValue(true);
    expect(requireStepUp('111111', REQ)).toEqual({ ok: true });
    // the failed replay must not burn unrelated codes
    expect(requireStepUp('222222', REQ)).toEqual({ ok: true });
  });
});

describe('verifyAndBurnTotpCode failure throttle', () => {
  it('locks a throttle key after 5 failed attempts and refuses even valid codes', () => {
    // unique key so this test is isolated from other tests in this file
    const key = 'test-lock-1';
    mocks.verifyTOTP.mockReturnValue(false);
    for (let i = 0; i < 5; i++) {
      expect(verifyAndBurnTotpCode('00000' + i, 'S', key)).toMatchObject({ ok: false, reason: 'invalid' });
    }
    expect(isTotpThrottled(key)).toBe(true);
    // even a code that would verify is refused while locked
    mocks.verifyTOTP.mockReturnValue(true);
    const locked = verifyAndBurnTotpCode('123456', 'S', key);
    expect(locked.ok).toBe(false);
    if (locked.ok) throw new Error('expected failure');
    expect(locked.error).toMatch(/15 minutes/);
    // ...and verifyTOTP was NOT called for the locked attempt
    expect(mocks.verifyTOTP).not.toHaveBeenCalledWith('123456', 'S');
  });

  it('clears the failure counter on success', () => {
    const key = 'test-clear-1';
    mocks.verifyTOTP.mockReturnValue(false);
    for (let i = 0; i < 4; i++) verifyAndBurnTotpCode(String(710000 + i), 'S', key);
    expect(isTotpThrottled(key)).toBe(false);
    mocks.verifyTOTP.mockReturnValue(true);
    expect(verifyAndBurnTotpCode('710099', 'S', key)).toEqual({ ok: true });
    expect(isTotpThrottled(key)).toBe(false);
    // counter reset: 5 fresh failures needed to lock again
    mocks.verifyTOTP.mockReturnValue(false);
    for (let i = 0; i < 5; i++) verifyAndBurnTotpCode(String(720000 + i), 'S', key);
    expect(isTotpThrottled(key)).toBe(true);
  });

  it('does not throttle when no key is supplied', () => {
    mocks.verifyTOTP.mockReturnValue(false);
    for (let i = 0; i < 8; i++) {
      expect(verifyAndBurnTotpCode('33333' + (i % 10), 'S')).toMatchObject({ ok: false, reason: 'invalid' });
    }
  });

  it('does not count a replay (used) rejection as a failed attempt', () => {
    const key = 'test-replay-1';
    mocks.verifyTOTP.mockReturnValue(true);
    expect(verifyAndBurnTotpCode('654321', 'S', key)).toEqual({ ok: true });
    expect(verifyAndBurnTotpCode('654321', 'S', key)).toMatchObject({ ok: false, reason: 'used' });
    expect(isTotpThrottled(key)).toBe(false);
  });

  it('requireStepUp passes the client address as the throttle key', () => {
    mocks.getClientAddress.mockReturnValue('10.9.9.9');
    mocks.verifyTOTP.mockReturnValue(false);
    for (let i = 0; i < 5; i++) requireStepUp('00000' + i, REQ);
    const res = requireStepUp('000000', REQ);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.status).toBe(401);
    expect(res.error).toMatch(/15 minutes/);
  });
});

describe('totpFromBody', () => {
  it('extracts the totp_code field', () => {
    expect(totpFromBody({ totp_code: '123456' })).toBe('123456');
  });

  it('extracts the totpCode field', () => {
    expect(totpFromBody({ totpCode: '654321' })).toBe('654321');
  });

  it('prefers totp_code when both spellings are present', () => {
    expect(totpFromBody({ totp_code: '111111', totpCode: '222222' })).toBe('111111');
  });

  it('returns "" for null, undefined and non-object bodies', () => {
    expect(totpFromBody(null)).toBe('');
    expect(totpFromBody(undefined)).toBe('');
    expect(totpFromBody('123456')).toBe('');
    expect(totpFromBody(42)).toBe('');
  });

  it('returns "" when the field is not a string', () => {
    expect(totpFromBody({ totp_code: 123456 })).toBe('');
    expect(totpFromBody({ totpCode: null })).toBe('');
    expect(totpFromBody({})).toBe('');
  });
});
