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

import { GET } from '@/pages/api/passkey/register-options';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { getCredentials, createChallenge, getRpId, isValidRpId, makeChallengeCookieHeader } from '@/lib/passkey';

function makeCtx() {
  return {
    request: new Request('http://localhost:4321/api/passkey/register-options'),
  } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.mocked(getRpId).mockReturnValue('localhost');
  vi.mocked(isValidRpId).mockReturnValue(true);
  vi.mocked(getCredentials).mockReturnValue([]);
  vi.mocked(createChallenge).mockReturnValue('regtoken');
  vi.mocked(makeChallengeCookieHeader).mockReturnValue('pk_chal=regtoken; HttpOnly');
  vi.mocked(generateRegistrationOptions).mockResolvedValue({ challenge: 'regch', timeout: 60000 } as never);
});

describe('GET /api/passkey/register-options', () => {
  it('returns registration options with 200', async () => {
    const res = await GET(makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ challenge: 'regch' });
  });

  it('sets the challenge cookie', async () => {
    const res = await GET(makeCtx());
    expect(res.headers.get('Set-Cookie')).toContain('pk_chal=regtoken');
  });

  it('returns 400 when RP ID is an IP address', async () => {
    vi.mocked(getRpId).mockReturnValue('10.0.0.1');
    vi.mocked(isValidRpId).mockReturnValue(false);
    const res = await GET(makeCtx());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('hostname');
  });

  it('passes existing credential IDs to excludeCredentials', async () => {
    vi.mocked(getCredentials).mockReturnValue([
      { id: 'existing', publicKey: 'pk', counter: 0, name: 'old', createdAt: 1 },
    ]);
    await GET(makeCtx());
    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeCredentials: expect.arrayContaining([expect.objectContaining({ id: 'existing' })]),
      }),
    );
  });

  it('includes the rpID in the options', async () => {
    await GET(makeCtx());
    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ rpID: 'localhost' }),
    );
  });
});
