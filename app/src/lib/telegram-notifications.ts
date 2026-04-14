/**
 * telegram-notifications.ts — Wallet event detection and notification dispatch.
 *
 * Polls wallet and node state every POLL_INTERVAL_MS. On each tick it compares
 * the current state against the last known state and fires Telegram messages
 * for the events the user has enabled.
 *
 * Events tracked:
 *   received   — Balance increased (new incoming funds)
 *   confirmed  — New transaction(s) appeared in the confirmed list
 *   staking    — New blocks created by our pools (= staking reward earned)
 *   sync       — Wallet sync state changed (fell behind / caught up)
 *   offline    — Node/wallet RPC became unreachable or came back
 *   large_send — Outgoing amount exceeded the configured threshold
 */

import { getPref } from './prefs-db';
import { sendTelegramMessage } from './telegram';
import {
  getBalance,
  walletBestBlock,
  nodeBestBlockHeight,
  getStakingStatus,
  listCreatedBlocks,
  listTransactions,
  WalletRpcError,
} from './wallet-rpc';

// ── Config ─────────────────────────────────────────────────────────────────────

export const POLL_INTERVAL_MS = 30_000;

// Number of consecutive RPC failures before we consider the node offline
const OFFLINE_THRESHOLD = 3;
// Blocks behind threshold to trigger a "wallet syncing" notification
const SYNC_BEHIND_THRESHOLD = 10;

// ── State ──────────────────────────────────────────────────────────────────────

export interface NotificationState {
  initialized:          boolean;
  lastBalanceAtoms:     bigint;
  lastNodeHeight:       number;
  lastWalletHeight:     number;
  lastCreatedBlockCount: number;
  lastTxIds:            Set<string>;
  nodeOnline:           boolean;
  rpcFailures:          number;
  walletWasBehind:      boolean;
}

export function freshState(): NotificationState {
  return {
    initialized:           false,
    lastBalanceAtoms:      0n,
    lastNodeHeight:        0,
    lastWalletHeight:      0,
    lastCreatedBlockCount: 0,
    lastTxIds:             new Set(),
    nodeOnline:            true,
    rpcFailures:           0,
    walletWasBehind:       false,
  };
}

// ── Notification preference helpers ───────────────────────────────────────────

function notifEnabled(key: string, defaultOn: boolean): boolean {
  const val = getPref<boolean>(`telegram.notify.${key}`);
  return val === null ? defaultOn : val;
}

// ── Main poll tick ─────────────────────────────────────────────────────────────

/**
 * Run a single notification poll. Mutates `state` in place.
 * Call this repeatedly on a timer.
 */
export async function pollNotifications(
  botToken: string,
  chatId: string,
  state: NotificationState,
): Promise<void> {
  let balanceAtoms = 0n;
  let nodeHeight   = 0;
  let walletHeight = 0;
  let createdBlockCount = 0;
  let txIds: string[] = [];

  // ── Fetch current state ────────────────────────────────────────────────────
  try {
    const [bal, walletBlock, nh, blocks, txList] = await Promise.all([
      getBalance(0, 'Any'),
      walletBestBlock(),
      nodeBestBlockHeight(),
      listCreatedBlocks(0).catch(() => [] as Awaited<ReturnType<typeof listCreatedBlocks>>),
      listTransactions(0, 20).catch(() => [] as Awaited<ReturnType<typeof listTransactions>>),
    ]);

    balanceAtoms      = BigInt(bal.coins.atoms);
    nodeHeight        = nh;
    walletHeight      = walletBlock.height;
    createdBlockCount = blocks.length;
    txIds             = txList.map(t => t.id);

    // Node is reachable — reset failure counter
    if (!state.nodeOnline && state.rpcFailures >= OFFLINE_THRESHOLD) {
      await maybeNotify(botToken, chatId, 'offline',
        '🟢 <b>Node is back online</b>\n\nWallet RPC is reachable again.', true);
    }
    state.rpcFailures = 0;
    state.nodeOnline  = true;
  } catch (err) {
    state.rpcFailures += 1;

    if (state.rpcFailures === OFFLINE_THRESHOLD) {
      const msg = err instanceof WalletRpcError ? err.message : String(err);
      await maybeNotify(botToken, chatId, 'offline',
        `🔴 <b>Node appears offline</b>\n\n${msg}`, true);
      state.nodeOnline = false;
    }
    // Don't update state further — we have no fresh data
    return;
  }

  // ── First run: initialise baseline without firing events ───────────────────
  if (!state.initialized) {
    state.lastBalanceAtoms      = balanceAtoms;
    state.lastNodeHeight        = nodeHeight;
    state.lastWalletHeight      = walletHeight;
    state.lastCreatedBlockCount = createdBlockCount;
    state.lastTxIds             = new Set(txIds);
    state.walletWasBehind       = nodeHeight - walletHeight > SYNC_BEHIND_THRESHOLD;
    state.initialized           = true;
    return;
  }

  // ── Staking: new blocks created → reward earned ────────────────────────────
  if (createdBlockCount > state.lastCreatedBlockCount && notifEnabled('staking', true)) {
    const newBlocks = createdBlockCount - state.lastCreatedBlockCount;
    await maybeNotify(botToken, chatId, 'staking',
      `🏆 <b>Staking reward${newBlocks > 1 ? 's' : ''} earned!</b>\n\n` +
      `${newBlocks} new block${newBlocks > 1 ? 's' : ''} created by your pool.\n` +
      `Total blocks: ${createdBlockCount}`, true);
  }

  // ── Balance changes ────────────────────────────────────────────────────────
  const balanceDiff = balanceAtoms - state.lastBalanceAtoms;

  if (balanceDiff > 0n) {
    // Balance increased
    const newBlocks = createdBlockCount - state.lastCreatedBlockCount;
    if (newBlocks === 0) {
      // Not from staking — likely an incoming payment
      const diffDecimal = formatAtoms(balanceDiff);
      await maybeNotify(botToken, chatId, 'received',
        `📨 <b>Incoming transaction</b>\n\n` +
        `Received: <code>+${diffDecimal} ML</code>\n` +
        `New balance: <code>${formatAtoms(balanceAtoms)} ML</code>`, true);
    }
    // (Staking reward already handled above)
  } else if (balanceDiff < 0n) {
    // Balance decreased — outgoing transaction
    const diffDecimal = formatAtoms(-balanceDiff);
    const thresholdStr = getPref<string>('telegram.notify.large_send_threshold') ?? '100';
    const threshold = parseFloat(thresholdStr) || 100;
    const diffFloat = Number(-balanceDiff) / 1e11;

    if (diffFloat >= threshold) {
      await maybeNotify(botToken, chatId, 'large_send',
        `🚨 <b>Large send executed</b>\n\n` +
        `Amount: <code>-${diffDecimal} ML</code>\n` +
        `New balance: <code>${formatAtoms(balanceAtoms)} ML</code>`, false);
    }
  }

  // ── New confirmed transactions ─────────────────────────────────────────────
  const newTxIds = txIds.filter(id => !state.lastTxIds.has(id));
  if (newTxIds.length > 0 && state.lastTxIds.size > 0) {
    // Only notify if we had a previous snapshot (avoids spam on first real run)
    await maybeNotify(botToken, chatId, 'confirmed',
      `✅ <b>${newTxIds.length} transaction${newTxIds.length > 1 ? 's' : ''} confirmed</b>`, true);
  }

  // ── Sync state changes ─────────────────────────────────────────────────────
  const nowBehind = nodeHeight - walletHeight > SYNC_BEHIND_THRESHOLD;

  if (nowBehind && !state.walletWasBehind && nodeHeight > 0) {
    await maybeNotify(botToken, chatId, 'sync',
      `🔄 <b>Wallet is syncing</b>\n\n` +
      `Wallet: ${walletHeight.toLocaleString()} / Node: ${nodeHeight.toLocaleString()}\n` +
      `(${nodeHeight - walletHeight} blocks behind)`, true);
  } else if (!nowBehind && state.walletWasBehind) {
    await maybeNotify(botToken, chatId, 'sync',
      `✅ <b>Wallet sync complete</b>\n\nFully synced at height ${nodeHeight.toLocaleString()}.`, true);
  }

  // ── Update state ───────────────────────────────────────────────────────────
  state.lastBalanceAtoms      = balanceAtoms;
  state.lastNodeHeight        = nodeHeight;
  state.lastWalletHeight      = walletHeight;
  state.lastCreatedBlockCount = createdBlockCount;
  state.lastTxIds             = new Set(txIds);
  state.walletWasBehind       = nowBehind;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function maybeNotify(
  botToken: string,
  chatId: string,
  prefKey: string,
  text: string,
  defaultOn: boolean,
): Promise<void> {
  if (!notifEnabled(prefKey, defaultOn)) return;
  try {
    await sendTelegramMessage(botToken, chatId, text);
  } catch (err) {
    console.error(`[telegram-notifications] failed to send "${prefKey}" notification:`, err);
  }
}

/** Convert atoms (bigint) to a decimal ML string with up to 8 decimal places. */
function formatAtoms(atoms: bigint): string {
  const ATOMS_PER_ML = 100_000_000_000n; // 1e11
  const whole = atoms / ATOMS_PER_ML;
  const frac  = atoms % ATOMS_PER_ML;

  if (frac === 0n) return whole.toLocaleString();

  const fracStr = frac.toString().padStart(11, '0').replace(/0+$/, '');
  return `${whole.toLocaleString()}.${fracStr}`;
}
