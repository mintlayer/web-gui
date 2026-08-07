#!/usr/bin/env node
/**
 * Mintlayer wallet MCP server (stdio).
 *
 * Runs from the web-gui image with no build step:
 *   docker compose run --rm -T --no-deps web-gui node scripts/mcp-server.mjs
 *
 * Talks directly to wallet-rpc-daemon (same env vars as the web app) and
 * re-reads permissions from the prefs SQLite on every tool call, so changes
 * made in Management → Settings → MCP Server apply immediately.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { METHOD_TIERS, checkMethodAccess } from './mcp-permissions.mjs';

const WALLET_RPC_URL = process.env.WALLET_RPC_URL ?? 'http://localhost:3034';
const WALLET_RPC_USERNAME = process.env.WALLET_RPC_USERNAME ?? '';
const WALLET_RPC_PASSWORD = process.env.WALLET_RPC_PASSWORD ?? '';

// Read at call time (not import) so a fresh env — including a test's temp DB —
// always wins.
function prefsDbPath() {
  return process.env.PREFS_DB_PATH ?? join('/app/prefs', 'mintlayer_prefs.sqlite');
}

// ── Permissions (fresh read per call so panel changes apply immediately) ──────

export function readPerms() {
  let db;
  try {
    db = new Database(prefsDbPath(), { readonly: true, fileMustExist: true });
    const get = (key) => {
      const row = db.prepare('SELECT value FROM prefs WHERE key = ?').get(key);
      return row ? JSON.parse(row.value) : null;
    };
    return {
      enabled: get('mcp.enabled') === true,
      allowActions: get('mcp.allow_actions') === true,
      allowSpend: get('mcp.allow_spend') === true,
    };
  } catch {
    // No prefs DB → treat as fully disabled (fail closed)
    return { enabled: false, allowActions: false, allowSpend: false };
  } finally {
    db?.close();
  }
}

// ── Minimal JSON-RPC client (same wire format as src/lib/wallet-rpc.ts) ───────

let _reqId = 0;

export async function rpcCall(method, params = {}) {
  const auth = Buffer.from(`${WALLET_RPC_USERNAME}:${WALLET_RPC_PASSWORD}`).toString('base64');
  const res = await fetch(WALLET_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_reqId, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from wallet-rpc-daemon`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

// ── Tool plumbing ─────────────────────────────────────────────────────────────

function deny(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Check every RPC method the tool will use, then run it. */
export async function guarded(methods, fn) {
  const perms = readPerms();
  for (const method of methods) {
    const err = checkMethodAccess(method, perms);
    if (err) return deny(err);
  }
  try {
    const result = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return deny(`Wallet RPC error: ${err.message}`);
  }
}

/** For composite status tools: individual failures become strings, not errors. */
export async function tolerant(method, params) {
  try {
    return await rpcCall(method, params);
  } catch (err) {
    return `unavailable: ${err.message}`;
  }
}

const account = z.number().int().min(0).default(0).describe('Account index (default 0)');

const server = new McpServer({ name: 'mintlayer-wallet', version: '1.0.0' });

// Capture each tool's handler so it's unit-testable without a live stdio transport.
export const toolHandlers = {};
function registerTool(name, def, handler) {
  toolHandlers[name] = handler;
  server.registerTool(name, def, handler);
}

// ── Read tools ────────────────────────────────────────────────────────────────

registerTool(
  'get_status',
  {
    description:
      'Overview of node and wallet: node height, chainstate/sync info, wallet info, wallet sync height, staking status.',
  },
  () =>
    guarded(
      ['node_best_block_height', 'node_chainstate_info', 'wallet_info', 'wallet_best_block', 'staking_status'],
      async () => {
        const [nodeHeight, chainstate, wallet, walletBlock, staking] = await Promise.all([
          tolerant('node_best_block_height', {}),
          tolerant('node_chainstate_info', {}),
          tolerant('wallet_info', {}),
          tolerant('wallet_best_block', {}),
          tolerant('staking_status', { account: 0 }),
        ]);
        return { node_height: nodeHeight, chainstate, wallet, wallet_best_block: walletBlock, staking_status: staking };
      },
    ),
);

registerTool(
  'get_balance',
  {
    description: 'Wallet balance (coins and tokens) for an account.',
    inputSchema: {
      account,
      with_locked: z.enum(['Unlocked', 'Locked', 'Any']).default('Unlocked'),
    },
  },
  ({ account, with_locked }) =>
    guarded(['account_balance'], () =>
      rpcCall('account_balance', { account, utxo_states: ['Confirmed'], with_locked }),
    ),
);

registerTool(
  'list_addresses',
  {
    description: 'List wallet addresses with usage and per-address coin balance.',
    inputSchema: { account, include_change: z.boolean().default(false) },
  },
  ({ account, include_change }) =>
    guarded(['address_show'], () =>
      rpcCall('address_show', { account, include_change_addresses: include_change }),
    ),
);

registerTool(
  'list_transactions',
  {
    description: 'List recent wallet transactions plus pending (unconfirmed) transaction IDs.',
    inputSchema: { account, limit: z.number().int().min(1).max(500).default(50) },
  },
  ({ account, limit }) =>
    guarded(['transaction_list_by_address', 'transaction_list_pending'], async () => {
      const [transactions, pending] = await Promise.all([
        rpcCall('transaction_list_by_address', { account, address: null, limit }),
        rpcCall('transaction_list_pending', { account }),
      ]);
      return { transactions, pending };
    }),
);

registerTool(
  'list_utxos',
  { description: 'List the wallet UTXOs for an account.', inputSchema: { account } },
  ({ account }) => guarded(['account_utxos'], () => rpcCall('account_utxos', { account })),
);

registerTool(
  'get_staking_overview',
  {
    description: 'Staking overview: status, own pools, delegations, and blocks created by this wallet.',
    inputSchema: { account },
  },
  ({ account }) =>
    guarded(
      ['staking_status', 'staking_list_pools', 'delegation_list_ids', 'staking_list_created_block_ids'],
      async () => {
        const [status, pools, delegations, createdBlocks] = await Promise.all([
          tolerant('staking_status', { account }),
          tolerant('staking_list_pools', { account }),
          tolerant('delegation_list_ids', { account }),
          tolerant('staking_list_created_block_ids', { account }),
        ]);
        return { status, pools, delegations, created_blocks: createdBlocks };
      },
    ),
);

registerTool(
  'list_orders',
  {
    description: "List token trading orders: the wallet's own orders, or all active orders on chain.",
    inputSchema: { account, scope: z.enum(['own', 'all']).default('own') },
  },
  ({ account, scope }) =>
    guarded([scope === 'own' ? 'order_list_own' : 'order_list_all_active'], () =>
      scope === 'own'
        ? rpcCall('order_list_own', { account })
        : rpcCall('order_list_all_active', { account, ask_currency: null, give_currency: null }),
    ),
);

// ── Action tools (gated by mcp.allow_actions) ─────────────────────────────────

registerTool(
  'new_address',
  { description: 'Generate a new receive address. Requires "Allow wallet actions".', inputSchema: { account } },
  ({ account }) => guarded(['address_new'], () => rpcCall('address_new', { account })),
);

registerTool(
  'set_staking',
  {
    description: 'Start or stop staking. Requires "Allow wallet actions".',
    inputSchema: { account, enabled: z.boolean() },
  },
  ({ account, enabled }) =>
    guarded([enabled ? 'staking_start' : 'staking_stop'], () =>
      rpcCall(enabled ? 'staking_start' : 'staking_stop', { account }),
    ),
);

// ── Spend tools (gated by mcp.allow_spend) ────────────────────────────────────

registerTool(
  'send_coins',
  {
    description:
      'Send ML coins to an address. Moves real funds — requires "Allow fund-moving operations" in the settings panel.',
    inputSchema: {
      account,
      address: z.string().min(1).describe('Destination address'),
      amount: z.string().regex(/^\d+(\.\d+)?$/).describe('Decimal amount of ML, e.g. "1.5"'),
    },
  },
  ({ account, address, amount }) =>
    guarded(['address_send'], () =>
      rpcCall('address_send', { account, address, amount: { decimal: amount }, selected_utxos: [], options: {} }),
    ),
);

// ── Escape hatch ──────────────────────────────────────────────────────────────

registerTool(
  'wallet_rpc',
  {
    description:
      'Call any permitted wallet JSON-RPC method directly (see wallet-rpc-daemon docs/RPC.md for params). ' +
      `Available methods and their permission tier: ${Object.entries(METHOD_TIERS)
        .map(([m, t]) => `${m} (${t})`)
        .join(', ')}.`,
    inputSchema: {
      method: z.string().min(1),
      params: z.record(z.string(), z.unknown()).default({}),
    },
  },
  ({ method, params }) => guarded([method], () => rpcCall(method, params)),
);

// Only connect the stdio transport when run as the entry script — not when
// imported by tests.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await server.connect(new StdioServerTransport());
}
