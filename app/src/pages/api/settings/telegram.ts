import type { APIRoute } from 'astro';
import { setPref, getStringPref } from '@/lib/prefs-db';
import { sendTelegramMessage } from '@/lib/telegram';
import { json, LOGIN_BODY_LIMIT, readFormWithinLimit } from '@/lib/api-utils';
import { requireStepUp } from '@/lib/step-up';

export const POST: APIRoute = async ({ request, clientAddress }) => {
  // Body cap: request.formData() buffers the whole body before validation.
  const form = await readFormWithinLimit(request, LOGIN_BODY_LIMIT);
  if (!form) return json({ ok: false, error: 'Invalid request body' }, 400);

  // Coerce non-strings (e.g. File parts) to '' so they fail validation cleanly.
  const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');
  const botToken = str(form.get('bot_token'));
  const chatId   = str(form.get('chat_id'));
  const test     = form.get('test') === '1';
  const totpCode = str(form.get('totp_code'));

  // Blank fields keep the stored values (same contract as the settings
  // page) - a chat-id-only update must not wipe the stored bot token.
  const effToken = botToken || getStringPref('telegram.bot_token') || '';
  const effChatId = chatId || getStringPref('telegram.chat_id') || '';

  if (!effToken || !effChatId) {
    return json({ ok: false, error: 'Bot token and chat ID are required' }, 400);
  }
  // Digits only: negative group-chat IDs are refused because every group
  // member could run /balance and /address against the bot and read wallet
  // data (same rule as the settings page handler).
  if (!/^[0-9]{1,20}$/.test(effChatId)) {
    return json({ ok: false, error: 'Chat ID must be a numeric user or channel ID (group chats are not supported)' }, 400);
  }

  // Changing the notification channel redirects every wallet alert (balances,
  // incoming funds, receive addresses) - same sensitivity class as a password
  // change, so it requires a fresh 2FA code.
  const stepUp = requireStepUp(totpCode, request, clientAddress);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  setPref('telegram.bot_token', effToken);
  setPref('telegram.chat_id',   effChatId);

  if (test) {
    try {
      await sendTelegramMessage(effToken, effChatId, '✅ Test message from <b>Mintlayer Nexus</b> - Telegram notifications are working.');
    } catch (err) {
      return json({ ok: false, error: `Saved, but test message failed: ${(err as Error).message}` }, 200);
    }
  }

  return json({ ok: true }, 200);
};
