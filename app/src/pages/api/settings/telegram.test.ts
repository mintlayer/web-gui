import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prefs-db', () => ({
  setPref: vi.fn(),
}));

vi.mock('@/lib/telegram', () => ({
  sendTelegramMessage: vi.fn(),
}));

vi.mock('@/lib/step-up', () => ({
  requireStepUp: vi.fn(),
}));

import { POST } from '@/pages/api/settings/telegram';
import { setPref } from '@/lib/prefs-db';
import { sendTelegramMessage } from '@/lib/telegram';
import { requireStepUp } from '@/lib/step-up';

function makeForm(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request('http://localhost/api/settings/telegram', {
    method: 'POST',
    body: form,
  });
}

function makeCtx(req: Request) {
  return { request: req } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.mocked(setPref).mockReset();
  vi.mocked(sendTelegramMessage).mockReset();
  vi.mocked(requireStepUp).mockReset();
  vi.mocked(requireStepUp).mockReturnValue({ ok: true });
});

describe('POST /api/settings/telegram', () => {
  it('returns 400 when bot_token is missing', async () => {
    const res = await POST(makeCtx(makeForm({ bot_token: '', chat_id: '123', totp_code: '123456' })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('returns 400 when chat_id is missing', async () => {
    const res = await POST(makeCtx(makeForm({ bot_token: 'mytoken', chat_id: '', totp_code: '123456' })));
    expect(res.status).toBe(400);
  });

  it('rejects without a valid 2FA code', async () => {
    vi.mocked(requireStepUp).mockReturnValue({ ok: false, status: 401, error: 'Invalid authenticator code.' });
    const res = await POST(makeCtx(makeForm({ bot_token: 'mytoken', chat_id: '123456', totp_code: '000000' })));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(setPref).not.toHaveBeenCalled();
  });

  it('passes the submitted code to the step-up gate', async () => {
    await POST(makeCtx(makeForm({ bot_token: 'mytoken', chat_id: '123456', totp_code: '654321' })));
    expect(requireStepUp).toHaveBeenCalledWith('654321', expect.any(Request), undefined);
  });

  it('saves settings and returns ok without sending test message', async () => {
    const res = await POST(makeCtx(makeForm({ bot_token: 'mytoken', chat_id: '123456', totp_code: '123456' })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(setPref).toHaveBeenCalledWith('telegram.bot_token', 'mytoken');
    expect(setPref).toHaveBeenCalledWith('telegram.chat_id', '123456');
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('sends a test message when test=1', async () => {
    vi.mocked(sendTelegramMessage).mockResolvedValue(undefined as never);
    const form = new FormData();
    form.append('bot_token', 'mytoken');
    form.append('chat_id', '123456');
    form.append('totp_code', '123456');
    form.append('test', '1');
    const ctx = makeCtx(new Request('http://localhost/api/settings/telegram', { method: 'POST', body: form }));
    const res = await POST(ctx);
    expect(res.status).toBe(200);
    expect(sendTelegramMessage).toHaveBeenCalledWith('mytoken', '123456', expect.stringContaining('Test message'));
  });

  it('returns 200 with error message when test message fails', async () => {
    vi.mocked(sendTelegramMessage).mockRejectedValue(new Error('network error'));
    const form = new FormData();
    form.append('bot_token', 'mytoken');
    form.append('chat_id', '123456');
    form.append('totp_code', '123456');
    form.append('test', '1');
    const ctx = makeCtx(new Request('http://localhost/api/settings/telegram', { method: 'POST', body: form }));
    const res = await POST(ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('network error');
  });

  it('returns 400 on invalid form body', async () => {
    const ctx = {
      request: new Request('http://localhost/api/settings/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    } as Parameters<typeof POST>[0];
    const res = await POST(ctx);
    expect(res.status).toBe(400);
  });
});
