import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  verifyTOTP: vi.fn(),
  generateTotpSecret: vi.fn(),
}));

vi.mock('@/lib/prefs-db', () => ({
  getStringPref: vi.fn(),
  setPref: vi.fn(),
}));

import { POST } from '@/pages/api/settings/reset-2fa';
import { verifyTOTP, generateTotpSecret } from '@/lib/auth';
import { getStringPref, setPref } from '@/lib/prefs-db';

function makeForm(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request('http://localhost/api/settings/reset-2fa', {
    method: 'POST',
    body: form,
  });
}

function makeCtx(req: Request) {
  return { request: req } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.mocked(verifyTOTP).mockReset();
  vi.mocked(generateTotpSecret).mockReset();
  vi.mocked(getStringPref).mockReset();
  vi.mocked(setPref).mockReset();
});

describe('POST /api/settings/reset-2fa', () => {
  it('returns 400 when 2FA is not configured', async () => {
    vi.mocked(getStringPref).mockReturnValue('');
    const res = await POST(makeCtx(makeForm({ totp_code: '123456' })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('not configured');
  });

  it('returns 401 when TOTP code is invalid', async () => {
    vi.mocked(getStringPref).mockReturnValue('SECRETSECRET');
    vi.mocked(verifyTOTP).mockReturnValue(false);
    const res = await POST(makeCtx(makeForm({ totp_code: '000000' })));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Invalid');
  });

  it('generates a new secret and returns the otpauth URI on success', async () => {
    vi.mocked(getStringPref).mockReturnValue('OLDSECRET');
    vi.mocked(verifyTOTP).mockReturnValue(true);
    vi.mocked(generateTotpSecret).mockReturnValue('NEWSECRET');
    const res = await POST(makeCtx(makeForm({ totp_code: '123456' })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.secret).toBe('NEWSECRET');
    expect(body.uri).toContain('otpauth://totp/');
    expect(body.uri).toContain('NEWSECRET');
    expect(setPref).toHaveBeenCalledWith('auth.totp_secret', 'NEWSECRET');
  });

  it('returns 400 on invalid form body', async () => {
    const ctx = {
      request: new Request('http://localhost/api/settings/reset-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    } as Parameters<typeof POST>[0];
    const res = await POST(ctx);
    expect(res.status).toBe(400);
  });
});
