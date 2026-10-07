import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(),
}));

vi.mock('@/lib/passkey', () => ({
  getCredentials: vi.fn(),
  createChallenge: vi.fn(),
  getRpId: vi.fn(),
  isValidRpId: vi.fn(),
  makeChallengeCookieHeader: vi.fn(),
}));

vi.mock('@/lib/step-up', () => ({
  requireStepUp: vi.fn(),
}));

import { POST } from '@/pages/api/passkey/register-options';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { getCredentials, createChallenge, getRpId, isValidRpId, makeChallengeCookieHeader } from '@/lib/passkey';
import { requireStepUp } from '@/lib/step-up';

const mockStepUp = vi.mocked(requireStepUp);

function makeCtx(body?: unknown) {
  return {
    request: new Request('http://localhost:4321/api/passkey/register-options', {
      method: 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStepUp.mockReturnValue({ ok: true });
  vi.mocked(getRpId).mockReturnValue('localhost');
  vi.mocked(isValidRpId).mockReturnValue(true);
  vi.mocked(getCredentials).mockReturnValue([]);
  vi.mocked(createChallenge).mockReturnValue('regtoken');
  vi.mocked(makeChallengeCookieHeader).mockReturnValue('pk_chal=regtoken; HttpOnly');
  vi.mocked(generateRegistrationOptions).mockResolvedValue({ challenge: 'regch', timeout: 60000 } as never);
});

describe('POST /api/passkey/register-options', () => {
  it('returns registration options with 200 when the 2FA code is valid', async () => {
    const res = await POST(makeCtx({ totp_code: '123456' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ challenge: 'regch' });
    expect(mockStepUp).toHaveBeenCalledWith('123456', expect.any(Request), undefined);
  });

  it('rejects with 401 and no challenge cookie when the code is invalid', async () => {
    mockStepUp.mockReturnValue({ ok: false, status: 401, error: 'Invalid authenticator code.' });
    const res = await POST(makeCtx({ totp_code: '000000' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('rejects with 401 when no code is supplied', async () => {
    mockStepUp.mockReturnValue({ ok: false, status: 401, error: 'Invalid authenticator code.' });
    const res = await POST(makeCtx({}));
    expect(res.status).toBe(401);
    expect(createChallenge).not.toHaveBeenCalled();
  });

  it('returns 400 on a non-JSON body', async () => {
    const res = await POST({
      request: new Request('http://localhost:4321/api/passkey/register-options', {
        method: 'POST',
        body: 'not-json',
      }),
    } as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    expect(mockStepUp).not.toHaveBeenCalled();
  });

  it('returns 429 with the limiter copy when throttled', async () => {
    mockStepUp.mockReturnValue({ ok: false, status: 429, error: 'Too many requests. Try again in a minute.' });
    const res = await POST(makeCtx({ totp_code: '123456' }));
    expect(res.status).toBe(429);
  });

  it('sets the challenge cookie on success', async () => {
    const res = await POST(makeCtx({ totp_code: '123456' }));
    expect(res.headers.get('Set-Cookie')).toContain('pk_chal=regtoken');
  });

  it('returns 400 when RP ID is an IP address', async () => {
    vi.mocked(getRpId).mockReturnValue('10.0.0.1');
    vi.mocked(isValidRpId).mockReturnValue(false);
    const res = await POST(makeCtx({ totp_code: '123456' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('hostname');
  });

  it('passes existing credential IDs to excludeCredentials', async () => {
    vi.mocked(getCredentials).mockReturnValue([
      { id: 'existing', publicKey: 'pk', counter: 0, name: 'old', createdAt: 1 },
    ]);
    await POST(makeCtx({ totp_code: '123456' }));
    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeCredentials: expect.arrayContaining([expect.objectContaining({ id: 'existing' })]),
      }),
    );
  });

  it('includes the rpID in the options', async () => {
    await POST(makeCtx({ totp_code: '123456' }));
    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ rpID: 'localhost' }),
    );
  });
});
