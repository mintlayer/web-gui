import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/plugins', () => ({
  togglePlugin: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getClientAddress: vi.fn(() => '10.0.0.1'),
}));

vi.mock('@/lib/step-up', () => ({
  verifyAndBurnTotpCode: vi.fn(),
}));

vi.mock('@/lib/prefs-db', () => ({
  getStringPref: vi.fn(() => 'SECRET'),
}));

import { POST } from '@/pages/api/plugins/[id]/toggle';
import { togglePlugin } from '@/lib/plugins';
import { verifyAndBurnTotpCode } from '@/lib/step-up';
import { makeApiContext } from '@/test/api-context';

const mockTogglePlugin = vi.mocked(togglePlugin);
const mockBurn = vi.mocked(verifyAndBurnTotpCode);

beforeEach(() => {
  vi.clearAllMocks();
  mockBurn.mockReturnValue({ ok: true });
});

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/plugins/my-plugin/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeCtx(id: string, body: unknown) {
  return makeApiContext({ params: { id }, request: makeRequest(body) });
}

describe('POST /api/plugins/[id]/toggle', () => {
  it('returns 400 for invalid JSON body', async () => {
    const req = new Request('http://localhost/api/plugins/my-plugin/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await POST(makeApiContext({ params: { id: 'my-plugin' }, request: req }));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: 'Invalid JSON body' });
  });

  it('returns 400 when enabled is a string', async () => {
    const res = await POST(makeCtx('my-plugin', { enabled: 'true' }));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: expect.stringContaining('boolean') });
  });

  it('returns 400 when enabled is null', async () => {
    const res = await POST(makeCtx('my-plugin', { enabled: null }));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(400);
  });

  it('returns 400 when enabled is missing', async () => {
    const res = await POST(makeCtx('my-plugin', {}));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(400);
  });

  it('returns 200 when togglePlugin succeeds with enabled=true (valid code)', async () => {
    const res = await POST(makeCtx('my-plugin', { enabled: true, totp_code: '123456' }));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mockTogglePlugin).toHaveBeenCalledWith('my-plugin', true);
    expect(mockBurn).toHaveBeenCalledWith('123456', 'SECRET', '10.0.0.1');
  });

  it('returns 200 when togglePlugin succeeds with enabled=false (no code needed)', async () => {
    const res = await POST(makeCtx('my-plugin', { enabled: false }));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mockTogglePlugin).toHaveBeenCalledWith('my-plugin', false);
    expect(mockBurn).not.toHaveBeenCalled();
  });

  it('rejects enable without a 2FA code', async () => {
    mockBurn.mockReturnValue({ ok: false, error: 'Invalid authenticator code.', reason: 'invalid' }); // an empty code fails
    const res = await POST(makeCtx('my-plugin', { enabled: true }));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(401);
    expect(body).toMatchObject({ ok: false });
    expect(mockTogglePlugin).not.toHaveBeenCalled();
  });

  it('rejects enable with an invalid code', async () => {
    mockBurn.mockReturnValue({ ok: false, error: 'Invalid authenticator code.', reason: 'invalid' });
    const res = await POST(makeCtx('my-plugin', { enabled: true, totp_code: '000000' }));
    expect(res.status).toBe(401);
    expect(mockTogglePlugin).not.toHaveBeenCalled();
  });

  it('returns 422 when togglePlugin throws', async () => {
    mockTogglePlugin.mockImplementationOnce(() => { throw new Error('not installed'); });
    const res = await POST(makeCtx('my-plugin', { enabled: true, totp_code: '123456' }));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(422);
    expect(body).toMatchObject({ ok: false, error: 'not installed' });
  });

  it('uses empty string for id when params.id is undefined', async () => {
    const res = await POST(makeApiContext({ params: {}, request: makeRequest({ enabled: true, totp_code: '123456' }) }));
    expect(res.status).toBe(200);
    expect(mockTogglePlugin).toHaveBeenCalledWith('', true);
  });
});
