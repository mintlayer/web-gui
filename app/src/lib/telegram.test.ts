import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./prefs-db', () => ({
  getStringPref: vi.fn(),
}));

import { sendTelegramMessage, sendTelegramPhoto, getUpdates, notifyTelegram } from './telegram';
import { getStringPref } from './prefs-db';

function mockFetch(ok: boolean, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  });
}

beforeEach(() => {
  vi.mocked(getStringPref).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── sendTelegramMessage ───────────────────────────────────────────────────────

describe('sendTelegramMessage', () => {
  it('calls the Telegram sendMessage API', async () => {
    vi.stubGlobal('fetch', mockFetch(true, {}));
    await sendTelegramMessage('TOKEN', '123', 'Hello');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws when the API returns a non-ok status', async () => {
    vi.stubGlobal('fetch', mockFetch(false, 'Bad Request'));
    await expect(sendTelegramMessage('TOKEN', '123', 'Hi')).rejects.toThrow('400');
  });
});

// ── sendTelegramPhoto ─────────────────────────────────────────────────────────

describe('sendTelegramPhoto', () => {
  it('calls the Telegram sendPhoto API', async () => {
    vi.stubGlobal('fetch', mockFetch(true, {}));
    await sendTelegramPhoto('TOKEN', '123', Buffer.from('img'), 'caption');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/sendPhoto'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws when the API returns a non-ok status', async () => {
    vi.stubGlobal('fetch', mockFetch(false, 'error'));
    await expect(sendTelegramPhoto('TOKEN', '123', Buffer.from('x'))).rejects.toThrow('sendPhoto');
  });
});

// ── getUpdates ────────────────────────────────────────────────────────────────

describe('getUpdates', () => {
  it('returns parsed update list on success', async () => {
    const updates = [{ update_id: 1, message: { text: 'hi' } }];
    vi.stubGlobal('fetch', mockFetch(true, { ok: true, result: updates }));
    const result = await getUpdates('TOKEN', 0, 1);
    expect(result).toEqual(updates);
  });

  it('returns empty array when result is missing', async () => {
    vi.stubGlobal('fetch', mockFetch(true, { ok: true }));
    const result = await getUpdates('TOKEN', 0);
    expect(result).toEqual([]);
  });

  it('throws when the API returns a non-ok status', async () => {
    vi.stubGlobal('fetch', mockFetch(false, 'Unauthorized'));
    await expect(getUpdates('TOKEN', 0)).rejects.toThrow('getUpdates');
  });
});

// ── notifyTelegram ────────────────────────────────────────────────────────────

describe('notifyTelegram', () => {
  it('sends a message when bot token and chat ID are configured', async () => {
    vi.mocked(getStringPref).mockImplementation((key) =>
      key === 'telegram.bot_token' ? 'TOKEN' : '123',
    );
    vi.stubGlobal('fetch', mockFetch(true, {}));
    await notifyTelegram('hello');
    expect(fetch).toHaveBeenCalled();
  });

  it('no-ops when bot token is not configured', async () => {
    vi.mocked(getStringPref).mockReturnValue('');
    vi.stubGlobal('fetch', mockFetch(true, {}));
    await notifyTelegram('hello');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('silently swallows errors instead of throwing', async () => {
    vi.mocked(getStringPref).mockImplementation((key) =>
      key === 'telegram.bot_token' ? 'TOKEN' : '123',
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(notifyTelegram('hello')).resolves.toBeUndefined();
  });
});
