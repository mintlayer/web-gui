import type { APIRoute } from 'astro';
import { setPref } from '@/lib/prefs-db';
import { sendTelegramMessage } from '@/lib/telegram';
import { json, readFormData } from '@/lib/api-utils';
import { requireStepUp } from '@/lib/step-up';

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const form = await readFormData(request);
  if (!form) return json({ ok: false, error: 'Invalid request body' }, 400);

  const botToken = (form.get('bot_token') as string | null) ?? '';
  const chatId   = (form.get('chat_id')   as string | null) ?? '';
  const test     = form.get('test') === '1';
  const totpCode = (form.get('totp_code') as string | null) ?? '';

  if (!botToken || !chatId) {
    return json({ ok: false, error: 'Bot token and chat ID are required' }, 400);
  }

  // Changing the notification channel redirects every wallet alert (balances,
  // incoming funds, receive addresses) — same sensitivity class as a password
  // change, so it requires a fresh 2FA code.
  const stepUp = requireStepUp(totpCode, request, clientAddress);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  setPref('telegram.bot_token', botToken);
  setPref('telegram.chat_id',   chatId);

  if (test) {
    try {
      await sendTelegramMessage(botToken, chatId, '✅ Test message from <b>Mintlayer GUI-X</b> - Telegram notifications are working.');
    } catch (err) {
      return json({ ok: false, error: `Saved, but test message failed: ${(err as Error).message}` }, 200);
    }
  }

  return json({ ok: true }, 200);
};
