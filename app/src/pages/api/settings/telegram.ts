import type { APIRoute } from 'astro';
import { setPref } from '@/lib/prefs-db';
import { sendTelegramMessage } from '@/lib/telegram';

export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  const botToken = (form.get('bot_token') as string | null) ?? '';
  const chatId   = (form.get('chat_id')   as string | null) ?? '';
  const test     = form.get('test') === '1';

  if (!botToken || !chatId) {
    return json({ ok: false, error: 'Bot token and chat ID are required' }, 400);
  }

  setPref('telegram.bot_token', botToken);
  setPref('telegram.chat_id',   chatId);

  if (test) {
    try {
      await sendTelegramMessage(botToken, chatId, '✅ Test message from <b>Mintlayer GUI-X</b> — Telegram notifications are working.');
    } catch (err) {
      return json({ ok: false, error: `Saved, but test message failed: ${(err as Error).message}` }, 200);
    }
  }

  return json({ ok: true }, 200);
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
