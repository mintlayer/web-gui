import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/plugins', () => ({
  uninstallPlugin: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({
  verifyTOTP: vi.fn().mockReturnValue(true),
}));
vi.mock('@/lib/prefs-db', () => ({
  getStringPref: vi.fn().mockReturnValue('totp-secret'),
}));

import { POST } from '@/pages/api/plugins/[id]/uninstall';
import { uninstallPlugin } from '@/lib/plugins';
import { verifyTOTP } from '@/lib/auth';
import { getStringPref } from '@/lib/prefs-db';
import { makeApiContext } from '@/test/api-context';

const mockUninstallPlugin = vi.mocked(uninstallPlugin);
const mockVerifyTOTP = vi.mocked(verifyTOTP);
const mockGetStringPref = vi.mocked(getStringPref);

beforeEach(() => {
  vi.clearAllMocks();
  // Restore per-test defaults (mockReturnValue overrides below would stick)
  mockGetStringPref.mockReturnValue('totp-secret');
  mockVerifyTOTP.mockReturnValue(true);
});

function makeCtx(id: string, totpCode: string | null = '123456') {
  const formData = new FormData();
  if (totpCode !== null) formData.append('totp_code', totpCode);
  return makeApiContext({
    params: { id },
    request: new Request(`http://localhost/api/plugins/${id}/uninstall`, {
      method: 'POST',
      body: formData,
    }),
  });
}

describe('POST /api/plugins/[id]/uninstall - TOTP step-up gate', () => {
  it('returns 400 when 2FA is not configured', async () => {
    mockGetStringPref.mockReturnValue('');
    const res = await POST(makeCtx('my-plugin'));
    expect(res.status).toBe(400);
    await expect(res.clone().json()).resolves.toMatchObject({ ok: false, error: '2FA not configured' });
  });

  it('returns 401 when the TOTP code is invalid', async () => {
    mockVerifyTOTP.mockReturnValueOnce(false);
    const res = await POST(makeCtx('my-plugin'));
    expect(res.status).toBe(401);
    expect(mockUninstallPlugin).not.toHaveBeenCalled();
  });

  it('returns 401 when the request carries no code (empty body)', async () => {
    mockVerifyTOTP.mockReturnValue(false); // an empty code verifies as false
    const res = await POST(makeCtx('my-plugin', null));
    expect(res.status).toBe(401);
    expect(mockUninstallPlugin).not.toHaveBeenCalled();
  });

  it('accepts a JSON body with totp_code', async () => {
    const res = await POST(makeApiContext({
      params: { id: 'my-plugin' },
      request: new Request('http://localhost/api/plugins/my-plugin/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totp_code: '654321' }),
      }),
    }));
    expect(res.status).toBe(200);
    expect(mockVerifyTOTP).toHaveBeenCalledWith('654321', 'totp-secret');
  });
});

describe('POST /api/plugins/[id]/uninstall', () => {
  it('returns 200 and calls uninstallPlugin on success', async () => {
    const res = await POST(makeCtx('my-plugin'));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mockUninstallPlugin).toHaveBeenCalledWith('my-plugin');
  });

  it('returns 422 when uninstallPlugin throws', async () => {
    mockUninstallPlugin.mockImplementationOnce(() => { throw new Error('not installed'); });
    const res = await POST(makeCtx('unknown'));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(422);
    expect(body).toMatchObject({ ok: false, error: 'not installed' });
  });

  it('uses empty string for id when params.id is undefined', async () => {
    const res = await POST({
      params: {},
      request: new Request('http://localhost/api/plugins/x/uninstall', { method: 'POST' }),
    } as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(mockUninstallPlugin).toHaveBeenCalledWith('');
  });
});
