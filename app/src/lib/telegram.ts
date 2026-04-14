/**
 * telegram.ts — Telegram Bot API primitives.
 *
 * Low-level helpers for the Telegram Bot API (send message, send photo,
 * poll for updates). Higher-level logic lives in telegram-bot.ts,
 * telegram-commands.ts, and telegram-notifications.ts.
 *
 * Configuration is read from the prefs DB (telegram.bot_token, telegram.chat_id).
 * notifyTelegram() is a fire-and-forget helper that silently no-ops when
 * Telegram is not configured.
 */

import { getStringPref } from './prefs-db';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name: string };
    chat: { id: number; type: string };
    text?: string;
    date: number;
  };
}

// ── Core API calls ─────────────────────────────────────────────────────────────

export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
}

/** Send a PNG image buffer as a photo. Caption supports HTML formatting. */
export async function sendTelegramPhoto(
  botToken: string,
  chatId: string,
  photoBuffer: Buffer,
  caption?: string,
): Promise<void> {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('photo', new Blob([new Uint8Array(photoBuffer)], { type: 'image/png' }), 'qr.png');
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendPhoto ${res.status}: ${body}`);
  }
}

/**
 * Long-poll for incoming updates. Returns immediately if there are pending
 * updates; waits up to `timeoutSec` seconds if the queue is empty.
 * Pass `offset` = last_update_id + 1 to acknowledge received updates.
 */
export async function getUpdates(
  botToken: string,
  offset: number,
  timeoutSec = 25,
): Promise<TelegramUpdate[]> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset, timeout: timeoutSec, allowed_updates: ['message'] }),
    // Node.js fetch: signal timeout slightly longer than Telegram's own timeout
    signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
  });
  if (!res.ok) {
    throw new Error(`Telegram getUpdates ${res.status}: ${await res.text()}`);
  }
  const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
  return data.result ?? [];
}

// ── Fire-and-forget helper ─────────────────────────────────────────────────────

/** Reads config from prefs, sends a message, silently no-ops if not configured. */
export async function notifyTelegram(text: string): Promise<void> {
  const botToken = getStringPref('telegram.bot_token');
  const chatId   = getStringPref('telegram.chat_id');
  if (!botToken || !chatId) return;
  try {
    await sendTelegramMessage(botToken, chatId, text);
  } catch (err) {
    console.error('[telegram] notification failed:', err);
  }
}
