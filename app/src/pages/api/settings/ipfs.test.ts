import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prefs-db', () => ({
  setPref: vi.fn(),
}));

import { POST } from '@/pages/api/settings/ipfs';
import { setPref } from '@/lib/prefs-db';

function makeForm(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request('http://localhost/api/settings/ipfs', {
    method: 'POST',
    body: form,
  });
}

function makeCtx(req: Request) {
  return { request: req } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.mocked(setPref).mockReset();
});

describe('POST /api/settings/ipfs', () => {
  it('saves filebase provider and token', async () => {
    const res = await POST(makeCtx(makeForm({ provider: 'filebase', filebase_token: 'mytoken', pinata_jwt: '' })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(setPref).toHaveBeenCalledWith('ipfs.provider', 'filebase');
    expect(setPref).toHaveBeenCalledWith('ipfs.filebase_token', 'mytoken');
  });

  it('saves pinata provider and JWT', async () => {
    const res = await POST(makeCtx(makeForm({ provider: 'pinata', filebase_token: '', pinata_jwt: 'myjwt' })));
    expect(res.status).toBe(200);
    expect(setPref).toHaveBeenCalledWith('ipfs.provider', 'pinata');
    expect(setPref).toHaveBeenCalledWith('ipfs.pinata_jwt', 'myjwt');
  });

  it('saves empty provider to disable IPFS', async () => {
    const res = await POST(makeCtx(makeForm({ provider: '', filebase_token: '', pinata_jwt: '' })));
    expect(res.status).toBe(200);
    expect(setPref).toHaveBeenCalledWith('ipfs.provider', '');
  });

  it('returns 400 for an invalid provider', async () => {
    const res = await POST(makeCtx(makeForm({ provider: 'unknown', filebase_token: '', pinata_jwt: '' })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Invalid provider');
  });

  it('returns 400 on invalid form body', async () => {
    const ctx = {
      request: new Request('http://localhost/api/settings/ipfs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    } as Parameters<typeof POST>[0];
    const res = await POST(ctx);
    expect(res.status).toBe(400);
  });
});
