import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/plugins', () => ({
  uninstallPlugin: vi.fn(),
}));

import { POST } from '@/pages/api/plugins/[id]/uninstall';
import { uninstallPlugin } from '@/lib/plugins';

const mockUninstallPlugin = vi.mocked(uninstallPlugin);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeCtx(id: string) {
  return {
    params: { id },
    request: new Request(`http://localhost/api/plugins/${id}/uninstall`, { method: 'POST' }),
  } as Parameters<typeof POST>[0];
}

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
