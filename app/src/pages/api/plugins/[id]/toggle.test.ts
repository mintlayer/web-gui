import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/plugins', () => ({
  togglePlugin: vi.fn(),
}));

import { POST } from '@/pages/api/plugins/[id]/toggle';
import { togglePlugin } from '@/lib/plugins';
import { makeApiContext } from '@/test/api-context';

const mockTogglePlugin = vi.mocked(togglePlugin);

beforeEach(() => {
  vi.clearAllMocks();
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

  it('returns 200 when togglePlugin succeeds with enabled=true', async () => {
    const res = await POST(makeCtx('my-plugin', { enabled: true }));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mockTogglePlugin).toHaveBeenCalledWith('my-plugin', true);
  });

  it('returns 200 when togglePlugin succeeds with enabled=false', async () => {
    const res = await POST(makeCtx('my-plugin', { enabled: false }));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mockTogglePlugin).toHaveBeenCalledWith('my-plugin', false);
  });

  it('returns 422 when togglePlugin throws', async () => {
    mockTogglePlugin.mockImplementationOnce(() => { throw new Error('not installed'); });
    const res = await POST(makeCtx('my-plugin', { enabled: true }));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(422);
    expect(body).toMatchObject({ ok: false, error: 'not installed' });
  });

  it('uses empty string for id when params.id is undefined', async () => {
    const res = await POST(makeApiContext({ params: {}, request: makeRequest({ enabled: true }) }));
    expect(res.status).toBe(200);
    expect(mockTogglePlugin).toHaveBeenCalledWith('', true);
  });
});
