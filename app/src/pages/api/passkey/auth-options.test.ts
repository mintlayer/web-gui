import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: vi.fn(),
}));

vi.mock('@/lib/passkey', () => ({
  getCredentials: vi.fn(),
  createChallenge: vi.fn(),
  getRpId: vi.fn(),
  isValidRpId: vi.fn(),
  makeChallengeCookieHeader: vi.fn(),
}));

import { GET } from '@/pages/api/passkey/auth-options';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { getCredentials, createChallenge, getRpId, isValidRpId, makeChallengeCookieHeader } from '@/lib/passkey';

function makeCtx() {
  return {
    request: new Request('http://localhost:4321/api/passkey/auth-options'),
  } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.mocked(getRpId).mockReturnValue('localhost');
  vi.mocked(isValidRpId).mockReturnValue(true);
  vi.mocked(getCredentials).mockReturnValue([]);
  vi.mocked(createChallenge).mockReturnValue('token123');
  vi.mocked(makeChallengeCookieHeader).mockReturnValue('pk_chal=token123; HttpOnly');
  vi.mocked(generateAuthenticationOptions).mockResolvedValue({ challenge: 'ch', timeout: 60000 } as never);
});

describe('GET /api/passkey/auth-options', () => {
  it('returns options JSON with 200', async () => {
    const res = await GET(makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ challenge: 'ch' });
  });

  it('sets the challenge cookie', async () => {
    const res = await GET(makeCtx());
    expect(res.headers.get('Set-Cookie')).toContain('pk_chal=token123');
  });

  it('returns 400 when RP ID is an IP address', async () => {
    vi.mocked(getRpId).mockReturnValue('192.168.1.1');
    vi.mocked(isValidRpId).mockReturnValue(false);
    const res = await GET(makeCtx());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('hostname');
  });

  it('passes existing credential IDs to allowCredentials', async () => {
    vi.mocked(getCredentials).mockReturnValue([
      { id: 'cred1', publicKey: 'pk', counter: 0, name: 'test', createdAt: 1 },
    ]);
    await GET(makeCtx());
    expect(generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        allowCredentials: expect.arrayContaining([expect.objectContaining({ id: 'cred1' })]),
      }),
    );
  });
});
