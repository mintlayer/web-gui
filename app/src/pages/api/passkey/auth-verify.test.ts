import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simplewebauthn/server', () => ({
  verifyAuthenticationResponse: vi.fn(),
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

vi.mock('@/lib/auth', () => ({
  generateSessionToken: vi.fn(),
  makeSessionCookieHeader: vi.fn(),
}));

import { POST } from '@/pages/api/passkey/auth-verify';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { getCredentials, saveCredentials, consumeChallenge, getRpId, getOrigin, isValidRpId, clearChallengeCookieHeader } from '@/lib/passkey';
import { generateSessionToken, makeSessionCookieHeader } from '@/lib/auth';

const STORED_CRED = { id: 'cred1', publicKey: 'cHVibGlja2V5', counter: 0, name: 'test', createdAt: 1 };

function makeCtx(body: unknown, cookie = 'pk_chal=validtoken') {
  return {
    request: new Request('http://localhost:4321/api/passkey/auth-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.mocked(getRpId).mockReturnValue('localhost');
  vi.mocked(getOrigin).mockReturnValue('http://localhost:4321');
  vi.mocked(isValidRpId).mockReturnValue(true);
  vi.mocked(consumeChallenge).mockReturnValue('expected-challenge');
  vi.mocked(getCredentials).mockReturnValue([STORED_CRED]);
  vi.mocked(saveCredentials).mockReturnValue(undefined);
  vi.mocked(clearChallengeCookieHeader).mockReturnValue('pk_chal=; Max-Age=0');
  vi.mocked(generateSessionToken).mockReturnValue('session-token');
  vi.mocked(makeSessionCookieHeader).mockReturnValue('session=session-token; HttpOnly');
  vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  } as never);
});

describe('POST /api/passkey/auth-verify', () => {
  it('returns ok and issues a session cookie on success', async () => {
    const res = await POST(makeCtx({ id: 'cred1', type: 'public-key' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(saveCredentials).toHaveBeenCalled();
    expect(generateSessionToken).toHaveBeenCalled();
  });

  it('returns 400 when RP ID is an IP', async () => {
    vi.mocked(getRpId).mockReturnValue('192.168.1.1');
    vi.mocked(isValidRpId).mockReturnValue(false);
    const res = await POST(makeCtx({ id: 'cred1' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when challenge cookie is missing', async () => {
    vi.mocked(consumeChallenge).mockReturnValue(null);
    const res = await POST(makeCtx({ id: 'cred1' }, ''));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Challenge');
  });

  it('returns 400 when credential is not registered', async () => {
    vi.mocked(getCredentials).mockReturnValue([]);
    const res = await POST(makeCtx({ id: 'unknown-cred' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('not registered');
  });

  it('returns 400 when verification fails', async () => {
    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({ verified: false } as never);
    const res = await POST(makeCtx({ id: 'cred1' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when verifyAuthenticationResponse throws', async () => {
    vi.mocked(verifyAuthenticationResponse).mockRejectedValue(new Error('bad signature'));
    const res = await POST(makeCtx({ id: 'cred1' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('bad signature');
  });

  it('updates the counter after successful verification', async () => {
    await POST(makeCtx({ id: 'cred1' }));
    const saved = vi.mocked(saveCredentials).mock.calls[0][0];
    expect(saved[0].counter).toBe(1);
  });
});
