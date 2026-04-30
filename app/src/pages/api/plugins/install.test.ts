import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/plugins', () => ({
  installPlugin: vi.fn(),
}));

import { POST } from '@/pages/api/plugins/install';
import { installPlugin } from '@/lib/plugins';

const mockInstallPlugin = vi.mocked(installPlugin);

const MANIFEST = {
  id: 'my-plugin',
  name: 'My Plugin',
  navLabel: 'My Plugin',
  version: '1.0.0',
  entry: 'index.js',
};

beforeEach(() => {
  vi.clearAllMocks();
});

function makeFile(size: number, name = 'plugin.tgz'): File {
  return new File([new Uint8Array(size)], name, { type: 'application/gzip' });
}

function makeRequest(file?: File | null): Request {
  const formData = new FormData();
  if (file !== undefined && file !== null) formData.append('plugin', file);
  return new Request('http://localhost/api/plugins/install', {
    method: 'POST',
    body: formData,
  });
}

describe('POST /api/plugins/install', () => {
  it('returns 400 when plugin field is missing', async () => {
    const res = await POST({ request: makeRequest() } as Parameters<typeof POST>[0]);
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false });
  });

  it('returns 400 when plugin file exceeds 50 MB', async () => {
    const file = makeFile(51 * 1024 * 1024);
    const res = await POST({ request: makeRequest(file) } as Parameters<typeof POST>[0]);
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: expect.stringContaining('large') });
  });

  it('returns 400 for invalid multipart body', async () => {
    const req = new Request('http://localhost/api/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugin: 'not-a-file' }),
    });
    const res = await POST({ request: req } as Parameters<typeof POST>[0]);
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false });
  });

  it('returns 200 with manifest on success', async () => {
    mockInstallPlugin.mockResolvedValueOnce(MANIFEST);
    const res = await POST({ request: makeRequest(makeFile(100)) } as Parameters<typeof POST>[0]);
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, plugin: MANIFEST });
  });

  it('returns 422 when installPlugin throws', async () => {
    mockInstallPlugin.mockRejectedValueOnce(new Error('plugin.json not found'));
    const res = await POST({ request: makeRequest(makeFile(100)) } as Parameters<typeof POST>[0]);
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(422);
    expect(body).toMatchObject({ ok: false, error: 'plugin.json not found' });
  });

  it('passes buffer to installPlugin', async () => {
    mockInstallPlugin.mockResolvedValueOnce(MANIFEST);
    const file = makeFile(42);
    await POST({ request: makeRequest(file) } as Parameters<typeof POST>[0]);
    expect(mockInstallPlugin).toHaveBeenCalledWith(expect.any(Buffer));
    const [buf] = mockInstallPlugin.mock.calls[0] as [Buffer];
    expect(buf.length).toBe(42);
  });
});
