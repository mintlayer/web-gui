/**
 * telegram-bot.ts — Background polling orchestrator.
 *
 * Starts two independent async loops when imported:
 *   1. Command loop  — long-polls Telegram's getUpdates, routes /commands.
 *   2. Notification loop — polls wallet/node state and fires event messages.
 *
 * Both loops are resilient: they wait for configuration to appear in the prefs
 * DB, and resume automatically if the bot token/chat ID is updated at runtime
 * without restarting the container.
 *
 * Import this file once (from middleware.ts) as a side-effect import:
 *   import '@/lib/telegram-bot';
 */

import { getStringPref } from './prefs-db';
import { getUpdates } from './telegram';
import { handleUpdate } from './telegram-commands';
import {
  freshState,
  pollNotifications,
  POLL_INTERVAL_MS,
  type NotificationState,
} from './telegram-notifications';

// ── Startup guard ──────────────────────────────────────────────────────────────
// Prevent double-start if the module is hot-reloaded in dev mode.

let _started = false;

if (!_started) {
  _started = true;
  console.log('[telegram-bot] starting background loops');
  runCommandLoop().catch(err =>
    console.error('[telegram-bot] command loop crashed unexpectedly:', err),
  );
  runNotificationLoop().catch(err =>
    console.error('[telegram-bot] notification loop crashed unexpectedly:', err),
  );
}

// ── Command loop ───────────────────────────────────────────────────────────────

async function runCommandLoop(): Promise<void> {
  let offset = 0;

  while (true) {
    const botToken = getStringPref('telegram.bot_token');
    const chatId   = getStringPref('telegram.chat_id');

    if (!botToken || !chatId) {
      await sleep(15_000); // wait for config to appear
      continue;
    }

    try {
      // Long-poll: blocks up to 25 s on Telegram's side, returns immediately
      // when updates are available.
      const updates = await getUpdates(botToken, offset, 25);

      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        // Fire-and-forget each update — don't block the poll loop
        handleUpdate(update, botToken, chatId).catch(err =>
          console.error('[telegram-bot] handleUpdate error:', err),
        );
      }
    } catch (err) {
      console.error('[telegram-bot] getUpdates failed:', err);
      await sleep(10_000); // back off before retrying
    }
  }
}

// ── Notification loop ──────────────────────────────────────────────────────────

async function runNotificationLoop(): Promise<void> {
  // State is intentionally re-created when config changes so that the first
  // tick after a config switch acts as a fresh baseline (no spurious alerts).
  let state: NotificationState = freshState();
  let lastConfigKey = '';

  while (true) {
    await sleep(POLL_INTERVAL_MS);

    const botToken = getStringPref('telegram.bot_token');
    const chatId   = getStringPref('telegram.chat_id');

    if (!botToken || !chatId) continue;

    // If the bot token or chat ID changed, reset state to avoid stale comparisons
    const configKey = `${botToken}:${chatId}`;
    if (configKey !== lastConfigKey) {
      state = freshState();
      lastConfigKey = configKey;
    }

    try {
      await pollNotifications(botToken, chatId, state);
    } catch (err) {
      console.error('[telegram-bot] pollNotifications error:', err);
    }
  }
}

// ── Utility ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
