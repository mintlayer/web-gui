import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prefs-db', () => ({
  getPref: vi.fn().mockReturnValue(0),
  setPref: vi.fn(),
}));

import { POST } from '@/pages/api/logout';
import { setPref } from '@/lib/prefs-db';

describe('POST /api/logout', () => {
  it('returns 302 redirect to /login', async () => {
    const req = new Request('http://localhost/api/logout', { method: 'POST' });
    const res = await POST({ request: req } as Parameters<typeof POST>[0]);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
    // Logout must invalidate outstanding tokens, not just clear the cookie.
    expect(setPref).toHaveBeenCalledWith('auth.session_version', 1);
  });

  it('clears the session cookie with Max-Age=0', async () => {
    const req = new Request('http://localhost/api/logout', { method: 'POST' });
    const res = await POST({ request: req } as Parameters<typeof POST>[0]);
    const cookie = res.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('session=');
  });

  it('sets HttpOnly and SameSite=Strict on the cleared cookie', async () => {
    const req = new Request('http://localhost/api/logout', { method: 'POST' });
    const res = await POST({ request: req } as Parameters<typeof POST>[0]);
    const cookie = res.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });
});
