import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
}));

vi.mock('@/lib/prefs-db', () => ({
  getStringPref: vi.fn(),
  setPref: vi.fn(),
}));

import { POST } from '@/pages/api/settings/password';
import { verifyPassword, hashPassword } from '@/lib/auth';
import { getStringPref, setPref } from '@/lib/prefs-db';

function makeForm(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request('http://localhost/api/settings/password', {
    method: 'POST',
    body: form,
  });
}

function makeCtx(req: Request) {
  return { request: req } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.mocked(verifyPassword).mockReset();
  vi.mocked(hashPassword).mockReset();
  vi.mocked(getStringPref).mockReset();
  vi.mocked(setPref).mockReset();
});

describe('POST /api/settings/password', () => {
  it('returns 400 when password is not configured', async () => {
    vi.mocked(getStringPref).mockReturnValue('');
    const res = await POST(makeCtx(makeForm({ current_password: 'x', new_password: 'newpass1', confirm_password: 'newpass1' })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('returns 401 when current password is wrong', async () => {
    vi.mocked(getStringPref).mockReturnValue('stored-hash');
    vi.mocked(verifyPassword).mockResolvedValue(false);
    const res = await POST(makeCtx(makeForm({ current_password: 'wrong', new_password: 'newpass1', confirm_password: 'newpass1' })));
    expect(res.status).toBe(401);
  });

  it('returns 400 when new password is too short', async () => {
    vi.mocked(getStringPref).mockReturnValue('stored-hash');
    vi.mocked(verifyPassword).mockResolvedValue(true);
    const res = await POST(makeCtx(makeForm({ current_password: 'current', new_password: 'short', confirm_password: 'short' })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('8 characters');
  });

  it('returns 400 when new passwords do not match', async () => {
    vi.mocked(getStringPref).mockReturnValue('stored-hash');
    vi.mocked(verifyPassword).mockResolvedValue(true);
    const res = await POST(makeCtx(makeForm({ current_password: 'current', new_password: 'newpassword', confirm_password: 'different' })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('do not match');
  });

  it('updates password hash and returns ok on success', async () => {
    vi.mocked(getStringPref).mockReturnValue('stored-hash');
    vi.mocked(verifyPassword).mockResolvedValue(true);
    vi.mocked(hashPassword).mockResolvedValue('new-hash');
    const res = await POST(makeCtx(makeForm({ current_password: 'current', new_password: 'newpassword', confirm_password: 'newpassword' })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(setPref).toHaveBeenCalledWith('auth.password_hash', 'new-hash');
  });

  it('returns 400 on invalid form body', async () => {
    const ctx = {
      request: new Request('http://localhost/api/settings/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    } as Parameters<typeof POST>[0];
    const res = await POST(ctx);
    expect(res.status).toBe(400);
  });
});
