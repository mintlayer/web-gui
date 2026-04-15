import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simplewebauthn/server', () => ({
  verifyRegistrationResponse: vi.fn(),
}));

vi.mock('@/lib/passkey', () => ({
  getCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  consumeChallenge: vi.fn(),
  getRpId: vi.fn(),
  getOrigin: vi.fn(),
  isValidRpId: vi.fn(),
  PASSKEY_CHALLENGE_COOKIE: 'pk_chal',
  clearChallengeCookieHeader: vi.fn(),
}));

import { POST } from '@/pages/api/passkey/register-verify';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { getCredentials, saveCredentials, consumeChallenge, getRpId, getOrigin, isValidRpId, clearChallengeCookieHeader } from '@/lib/passkey';

const MOCK_CRED = { id: 'newcred', publicKey: new Uint8Array([1, 2, 3]), counter: 0 };

function makeCtx(body: unknown, cookie = 'pk_chal=validtoken') {
  return {
    request: new Request('http://localhost:4321/api/passkey/register-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRpId).mockReturnValue('localhost');
  vi.mocked(getOrigin).mockReturnValue('http://localhost:4321');
  vi.mocked(isValidRpId).mockReturnValue(true);
  vi.mocked(consumeChallenge).mockReturnValue('expected-challenge');
  vi.mocked(getCredentials).mockReturnValue([]);
  vi.mocked(saveCredentials).mockReturnValue(undefined);
  vi.mocked(clearChallengeCookieHeader).mockReturnValue('pk_chal=; Max-Age=0');
  vi.mocked(verifyRegistrationResponse).mockResolvedValue({
    verified: true,
    registrationInfo: { credential: MOCK_CRED },
  } as never);
});

describe('POST /api/passkey/register-verify', () => {
  it('returns ok and saves the credential on success', async () => {
    const res = await POST(makeCtx({ id: 'newcred', name: 'My Key', type: 'public-key' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'newcred', name: 'My Key' })]),
    );
  });

  it('uses default name "Passkey" when name is not provided', async () => {
    await POST(makeCtx({ id: 'newcred', type: 'public-key' }));
    const saved = vi.mocked(saveCredentials).mock.calls[0][0];
    expect(saved[0].name).toBe('Passkey');
  });

  it('returns 400 when RP ID is an IP', async () => {
    vi.mocked(getRpId).mockReturnValue('192.168.1.1');
    vi.mocked(isValidRpId).mockReturnValue(false);
    const res = await POST(makeCtx({ id: 'x' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when challenge cookie is missing', async () => {
    vi.mocked(consumeChallenge).mockReturnValue(null);
    const res = await POST(makeCtx({ id: 'x' }, ''));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Challenge');
  });

  it('returns 400 when verification is not verified', async () => {
    vi.mocked(verifyRegistrationResponse).mockResolvedValue({ verified: false } as never);
    const res = await POST(makeCtx({ id: 'x' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when verifyRegistrationResponse throws', async () => {
    vi.mocked(verifyRegistrationResponse).mockRejectedValue(new Error('invalid response'));
    const res = await POST(makeCtx({ id: 'x' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('invalid response');
  });

  it('appends to existing credentials instead of replacing them', async () => {
    const existing = { id: 'old', publicKey: 'pk', counter: 0, name: 'old key', createdAt: 1 };
    vi.mocked(getCredentials).mockReturnValue([existing]);
    await POST(makeCtx({ id: 'newcred', name: 'new key' }));
    const saved = vi.mocked(saveCredentials).mock.calls[0][0];
    expect(saved).toHaveLength(2);
    expect(saved[0].id).toBe('old');
    expect(saved[1].id).toBe('newcred');
  });
});
