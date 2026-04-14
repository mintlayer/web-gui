/**
 * telegram-commands.ts — Bot command handlers.
 *
 * Read-only commands run freely. Write commands (/staking on|off) require an
 * inline TOTP code: e.g. `/staking on 123456`. The code is verified against
 * the same TOTP secret used for the web UI login, so no extra setup is needed.
 * TOTP codes are time-based (30 s window) which limits replay attacks.
 *
 * Security: every incoming update is validated against the configured chat ID
 * before any handler is invoked. Unknown senders receive no reply.
 */

import QRCode from 'qrcode';
import type { TelegramUpdate } from './telegram';
import { sendTelegramMessage, sendTelegramPhoto } from './telegram';
import { getPref, getStringPref } from './prefs-db';
import { verifyTOTP } from './auth';
import {
  getBalance,
  walletBestBlock,
  nodeBestBlockHeight,
  newAddress,
  walletInfo,
  getStakingStatus,
  startStaking,
  stopStaking,
  listPools,
  listDelegations,
  nodeChainstateInfo,
  WalletRpcError,
} from './wallet-rpc';

// ── Update router ──────────────────────────────────────────────────────────────

export async function handleUpdate(
  update: TelegramUpdate,
  botToken: string,
  allowedChatId: string,
): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  // Security: only respond to the configured chat ID
  if (String(msg.chat.id) !== allowedChatId) {
    console.warn(`[telegram-bot] ignoring message from unauthorized chat ${msg.chat.id}`);
    return;
  }

  const text = msg.text.trim();
  if (!text.startsWith('/')) return;

  // Strip optional @BotName suffix (e.g. /balance@mybot → /balance)
  const parts = text.split(/\s+/);
  const cmd   = parts[0].toLowerCase().replace(/@\S+$/, '');
  const args  = parts.slice(1); // e.g. ['on', '123456'] for "/staking on 123456"

  try {
    switch (cmd) {
      case '/balance': await cmdBalance(botToken, allowedChatId); break;
      case '/sync':    await cmdSync(botToken, allowedChatId); break;
      case '/address': await cmdAddress(botToken, allowedChatId); break;
      case '/status':  await cmdStatus(botToken, allowedChatId); break;
      case '/staking': await cmdStaking(botToken, allowedChatId, args); break;
      case '/start':
      case '/help':    await cmdHelp(botToken, allowedChatId); break;
      default:
        await sendTelegramMessage(
          botToken, allowedChatId,
          '❓ Unknown command. Use /help to see available commands.',
        );
    }
  } catch (err) {
    const msg = err instanceof WalletRpcError ? err.message : String(err);
    await sendTelegramMessage(botToken, allowedChatId, `⚠️ Error: ${msg}`).catch(() => {});
  }
}

// ── /help ──────────────────────────────────────────────────────────────────────

async function cmdHelp(botToken: string, chatId: string): Promise<void> {
  await sendTelegramMessage(botToken, chatId, [
    '🤖 <b>Mintlayer GUI-X Bot</b>',
    '',
    '<b>Read-only commands:</b>',
    '/balance — Current wallet balance',
    '/sync — Sync status and block heights',
    '/address — Generate a fresh receive address (with QR)',
    '/status — Overall node &amp; wallet health',
    '/staking — Staking status and pools',
    '',
    '<b>Write commands</b> (require your authenticator code):',
    '/staking on <code>123456</code> — Start staking',
    '/staking off <code>123456</code> — Stop staking',
    '/help — Show this message',
  ].join('\n'));
}

// ── /balance ───────────────────────────────────────────────────────────────────

async function cmdBalance(botToken: string, chatId: string): Promise<void> {
  const bal = await getBalance(0, 'Any');

  const lines: string[] = ['💰 <b>Wallet Balance</b>', ''];
  lines.push(`ML: <code>${bal.coins.decimal}</code>`);

  const tokens = Object.entries(bal.tokens);
  if (tokens.length > 0) {
    lines.push('');
    lines.push('<i>Tokens:</i>');
    for (const [tokenId, amount] of tokens) {
      lines.push(`• <code>${tokenId.slice(0, 16)}…</code>: ${amount.decimal}`);
    }
  }

  await sendTelegramMessage(botToken, chatId, lines.join('\n'));
}

// ── /sync ──────────────────────────────────────────────────────────────────────

async function cmdSync(botToken: string, chatId: string): Promise<void> {
  const [walletBlock, nodeHeight, chainstate] = await Promise.all([
    walletBestBlock(),
    nodeBestBlockHeight(),
    nodeChainstateInfo(),
  ]);

  const walletH  = walletBlock.height;
  const behind   = nodeHeight - walletH;
  const ibd      = chainstate.is_initial_block_download;
  const pct      = nodeHeight > 0 ? ((walletH / nodeHeight) * 100).toFixed(1) : '0.0';

  let statusLine: string;
  if (ibd) {
    statusLine = `⏳ Node is syncing (IBD) — ${pct}%`;
  } else if (behind <= 2) {
    statusLine = `✅ Fully synced`;
  } else {
    statusLine = `🔄 Wallet syncing — ${behind.toLocaleString()} blocks behind`;
  }

  await sendTelegramMessage(botToken, chatId, [
    '🔗 <b>Sync Status</b>',
    '',
    `Wallet height:  <code>${walletH.toLocaleString()}</code>`,
    `Node height:    <code>${nodeHeight.toLocaleString()}</code>`,
    '',
    statusLine,
  ].join('\n'));
}

// ── /address ──────────────────────────────────────────────────────────────────

async function cmdAddress(botToken: string, chatId: string): Promise<void> {
  const { address } = await newAddress(0);

  // Generate QR code PNG buffer
  let qrBuffer: Buffer | null = null;
  try {
    qrBuffer = await QRCode.toBuffer(address, { type: 'png', width: 300, margin: 2 });
  } catch {
    // Fall back to text-only if QR generation fails
  }

  if (qrBuffer) {
    await sendTelegramPhoto(
      botToken, chatId, qrBuffer,
      `📬 <b>Fresh Receive Address</b>\n\n<code>${address}</code>`,
    );
  } else {
    await sendTelegramMessage(
      botToken, chatId,
      `📬 <b>Fresh Receive Address</b>\n\n<code>${address}</code>`,
    );
  }
}

// ── /status ───────────────────────────────────────────────────────────────────

async function cmdStatus(botToken: string, chatId: string): Promise<void> {
  const [info, chainstate, walletBlock, nodeHeight, stakingStatus] = await Promise.all([
    walletInfo(),
    nodeChainstateInfo(),
    walletBestBlock(),
    nodeBestBlockHeight(),
    getStakingStatus(0).catch(() => null as null),
  ]);

  const behind   = nodeHeight - walletBlock.height;
  const ibd      = chainstate.is_initial_block_download;
  const synced   = !ibd && behind <= 2;
  const network  = (process.env.NETWORK ?? 'mainnet').toLowerCase();
  const stakeStr = stakingStatus === 'Staking' ? '⛏ Staking active' : '💤 Not staking';

  await sendTelegramMessage(botToken, chatId, [
    '📊 <b>Node &amp; Wallet Status</b>',
    '',
    `🌐 Network:  <code>${network}</code>`,
    `📦 Node:     <code>${nodeHeight.toLocaleString()}</code> blocks${ibd ? ' (syncing)' : ''}`,
    `💼 Wallet:   <code>${walletBlock.height.toLocaleString()}</code> blocks${synced ? ' ✅' : ` (${behind} behind)`}`,
    `🆔 Wallet ID: <code>${info.wallet_id.slice(0, 20)}…</code>`,
    '',
    stakeStr,
  ].join('\n'));
}

// ── /staking [on|off <totp>] ──────────────────────────────────────────────────

async function cmdStaking(botToken: string, chatId: string, args: string[]): Promise<void> {
  const subCmd = args[0]?.toLowerCase();

  // ── Write: /staking on <totp> / /staking off <totp> ───────────────────────
  if (subCmd === 'on' || subCmd === 'off') {
    if (!(getPref<boolean>('telegram.staking.controls') ?? false)) {
      await sendTelegramMessage(botToken, chatId,
        '🔒 Staking controls are disabled.\n\nEnable them in Management → Settings → Telegram notifications.');
      return;
    }

    const totpCode = args[1] ?? '';

    if (!totpCode) {
      await sendTelegramMessage(botToken, chatId,
        `🔐 Authenticator code required.\n\nUsage: <code>/staking ${subCmd} 123456</code>`);
      return;
    }

    const secret = getStringPref('auth.totp_secret');
    if (!secret) {
      await sendTelegramMessage(botToken, chatId,
        '⚠️ 2FA is not configured on this wallet. Cannot verify write commands.');
      return;
    }

    if (!verifyTOTP(totpCode, secret)) {
      await sendTelegramMessage(botToken, chatId,
        '❌ Invalid authenticator code. Staking not changed.');
      return;
    }

    if (subCmd === 'on') {
      await startStaking(0);
      await sendTelegramMessage(botToken, chatId, '⛏ <b>Staking started.</b>');
    } else {
      await stopStaking(0);
      await sendTelegramMessage(botToken, chatId, '💤 <b>Staking stopped.</b>');
    }
    return;
  }

  // ── Read-only: /staking (no args) — show status ────────────────────────────
  if (!(getPref<boolean>('telegram.staking.status') ?? true)) {
    await sendTelegramMessage(botToken, chatId,
      '🔒 Staking status command is disabled.\n\nEnable it in Management → Settings → Telegram notifications.');
    return;
  }

  if (subCmd && subCmd !== 'status') {
    await sendTelegramMessage(botToken, chatId,
      'Usage:\n/staking — show status\n/staking on <code>123456</code> — start\n/staking off <code>123456</code> — stop');
    return;
  }

  const [status, pools, delegations] = await Promise.all([
    getStakingStatus(0),
    listPools(0).catch(() => [] as Awaited<ReturnType<typeof listPools>>),
    listDelegations(0).catch(() => [] as Awaited<ReturnType<typeof listDelegations>>),
  ]);

  const statusEmoji = status === 'Staking' ? '⛏' : '💤';
  const lines: string[] = [
    `${statusEmoji} <b>Staking Status: ${status}</b>`,
    '',
  ];

  if (pools.length > 0) {
    lines.push(`<b>Pools (${pools.length}):</b>`);
    for (const p of pools) {
      lines.push(`• <code>${p.pool_id.slice(0, 16)}…</code>`);
      lines.push(`  Balance: ${p.balance.decimal} ML`);
      lines.push(`  Pledge:  ${p.pledge.decimal} ML`);
    }
  } else {
    lines.push('No staking pools.');
  }

  if (delegations.length > 0) {
    lines.push('');
    lines.push(`<b>Delegations (${delegations.length}):</b>`);
    let totalDel = 0n;
    for (const d of delegations) {
      totalDel += BigInt(d.balance.atoms);
      lines.push(`• Pool <code>${d.pool_id.slice(0, 16)}…</code>: ${d.balance.decimal} ML`);
    }
    const totalDecimal = (Number(totalDel) / 1e11).toFixed(4);
    lines.push(`Total delegated: <b>${totalDecimal} ML</b>`);
  }

  lines.push('');
  lines.push('<i>To toggle: /staking on|off &lt;authenticator code&gt;</i>');

  await sendTelegramMessage(botToken, chatId, lines.join('\n'));
}
