import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { rpcCall, WalletRpcError } from '@/lib/wallet-rpc';
import { requireStepUp, totpFromBody } from '@/lib/step-up';
import { isValidAmount } from '@/lib/validation';

/**
 * POST /api/stake-trade - TOTP-gated staking & trading transaction endpoint.
 *
 * Delegation staking/withdrawal, pool creation/decommissioning and order
 * creation/filling/cancellation all sign on-chain transactions that move
 * funds (or burn creation fees) — they require a fresh TOTP code (step-up)
 * on top of the session cookie, exactly like /api/send and /api/token-manage.
 * These methods are intentionally absent from the browser/plugin RPC
 * allowlist, so this is the only path — a stolen session cookie alone cannot
 * stake, withdraw, create a pool, or place/fill orders.
 *
 * Accepts a single action ({action, params}) or a small ordered batch
 * ({actions: [...]}) so compound user intents (create delegation + initial
 * stake) burn exactly ONE code.
 *
 * Every action has a strict per-action parameter whitelist validated BEFORE
 * the TOTP code is burned, so knowable failures never consume a code.
 * The daemon remains the authoritative validator for chain-level semantics.
 */

type Params = Record<string, unknown>;

const ACTIONS = new Set([
  'delegation_create',
  'delegation_stake',
  'delegation_withdraw',
  'staking_sweep_delegation',
  'staking_create_pool',
  'staking_decommission_pool',
  'order_create',
  'order_fill',
  'order_conclude',
]);

const MAX_BATCH = 5;

// Charset/length bounds for chain identifiers and addresses. The daemon
// validates semantics (checksum, network prefix); this only stops garbage
// before a code is burned.
const ID_RE = /^[a-z0-9]{10,120}$/i;
const DECIMAL_RE = /^\d{1,20}(\.\d{1,18})?$/;

function isStr(v: unknown, re: RegExp): boolean {
  return typeof v === 'string' && re.test(v);
}

function isObj(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isAmountField(v: unknown): boolean {
  return isObj(v) && typeof (v as Params).decimal === 'string' &&
    isValidAmount((v as Params).decimal as string, 18);
}

// Order legs carry either a decimal or an atom amount (NFTs trade in atoms).
function isCoinAmount(v: unknown): boolean {
  if (!isObj(v)) return false;
  const a = v as Params;
  if (typeof a.decimal === 'string') return isValidAmount(a.decimal, 18);
  return typeof a.atoms === 'string' && /^\d{1,40}$/.test(a.atoms);
}

// give/ask leg: Coin (ML) or Token (id + amount)
function isOrderLeg(v: unknown): boolean {
  if (!isObj(v)) return false;
  const leg = v as Params;
  if (leg.type === 'Coin') {
    return isObj(leg.content) && isCoinAmount((leg.content as Params).amount);
  }
  if (leg.type === 'Token') {
    if (!isObj(leg.content)) return false;
    const c = leg.content as Params;
    return isStr(c.id, ID_RE) && isCoinAmount(c.amount);
  }
  return false;
}

function validateParams(action: string, p: Params): string | null {
  const opts = 'options' in p && p.options !== undefined ? (isObj(p.options) ? null : 'options must be an object') : null;
  if (opts) return opts;

  switch (action) {
    case 'delegation_create': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.pool_id, ID_RE)) return 'pool_id is required';
      if (!isStr(p.address, ID_RE)) return 'address is required';
      return null;
    }
    case 'delegation_stake': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.delegation_id, ID_RE)) return 'delegation_id is required';
      if (!isAmountField(p.amount)) return 'amount is invalid';
      return null;
    }
    case 'delegation_withdraw': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.delegation_id, ID_RE)) return 'delegation_id is required';
      if (!isAmountField(p.amount)) return 'amount is invalid';
      if (!isStr(p.address, ID_RE)) return 'address is required';
      return null;
    }
    case 'staking_sweep_delegation': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.delegation_id, ID_RE)) return 'delegation_id is required';
      if (!isStr(p.destination_address, ID_RE)) return 'destination_address is required';
      return null;
    }
    case 'staking_create_pool': {
      if (p.account !== 0) return 'account must be 0';
      if (!isAmountField(p.amount)) return 'amount is invalid';
      if (!isObj(p.cost_per_block) || typeof (p.cost_per_block as Params).decimal !== 'string' ||
          !DECIMAL_RE.test((p.cost_per_block as Params).decimal as string)) return 'cost_per_block is invalid';
      if (typeof p.margin_ratio_per_thousand !== 'string' ||
          !DECIMAL_RE.test(p.margin_ratio_per_thousand) ||
          parseFloat(p.margin_ratio_per_thousand) <= 0 ||
          parseFloat(p.margin_ratio_per_thousand) > 1000) return 'margin_ratio_per_thousand must be a ratio in (0, 1000]';
      if (!isStr(p.decommission_address, ID_RE)) return 'decommission_address is required';
      if (p.staker_address !== null) return 'staker_address must be null';
      if (p.vrf_public_key !== null) return 'vrf_public_key must be null';
      return null;
    }
    case 'staking_decommission_pool': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.pool_id, ID_RE)) return 'pool_id is required';
      if (p.output_address !== null) return 'output_address must be null';
      return null;
    }
    case 'order_create': {
      if (p.account !== 0) return 'account must be 0';
      if (!isOrderLeg(p.give)) return 'give leg is invalid';
      if (!isOrderLeg(p.ask)) return 'ask leg is invalid';
      if (!isStr(p.conclude_address, ID_RE)) return 'conclude_address is required';
      return null;
    }
    case 'order_fill': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.order_id, ID_RE)) return 'order_id is required';
      if (!isAmountField(p.fill_amount_in_ask_currency)) return 'fill amount is invalid';
      if (p.output_address !== null) return 'output_address must be null';
      return null;
    }
    case 'order_conclude': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.order_id, ID_RE)) return 'order_id is required';
      return null;
    }
    default:
      return 'Unknown action';
  }
}

interface BatchItem {
  action: string;
  params: Params;
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let body: Record<string, unknown> = {};
  let items: BatchItem[] = [];
  try {
    body = (await request.json()) as Record<string, unknown>;
    const raw = Array.isArray(body.actions) ? body.actions : (body.action ? [body] : null);
    if (!raw) {
      return json({ ok: false, error: 'Invalid request body' }, 400);
    }
    if (raw.length < 1 || raw.length > MAX_BATCH) {
      return json({ ok: false, error: `actions must contain 1-${MAX_BATCH} items` }, 400);
    }
    for (const entry of raw) {
      if (!isObj(entry) || typeof (entry as Params).action !== 'string' || !isObj((entry as Params).params)) {
        return json({ ok: false, error: 'Invalid request body' }, 400);
      }
      items.push({ action: (entry as Params).action as string, params: (entry as Params).params as Params });
    }
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  // Validate everything BEFORE burning the code: a knowable 400 must not
  // cost the user their authenticator code (same ordering as the bridge
  // intent and token-manage endpoints).
  for (const item of items) {
    if (!ACTIONS.has(item.action)) {
      return json({ ok: false, error: 'Unknown action' }, 400);
    }
    const invalid = validateParams(item.action, item.params);
    if (invalid) {
      return json({ ok: false, error: `${item.action}: ${invalid}` }, 400);
    }
  }

  const stepUp = requireStepUp(totpFromBody(body), request, clientAddress as string | undefined);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  const results: Record<string, unknown>[] = [];
  try {
    for (const item of items) {
      results.push(await rpcCall<Record<string, unknown>>(item.action, item.params));
    }
    return json({ ok: true, results });
  } catch (err) {
    // Step-up already ran: the TOTP code is burned even though a later
    // action in the batch may not have been submitted. Flag it so the UI
    // can ask for a FRESH code instead of the user silently retrying the
    // dead one. `completed` says how many actions did succeed.
    if (err instanceof WalletRpcError) {
      // Transport-class failures (-32000/-32001/5xx) carry the daemon URL in
      // their message — never forward those to the browser (mirror of the
      // rpc.ts proxy redaction). Daemon user-actionable messages (insufficient
      // funds, orphaned transactions) still pass through.
      const transport = err.code === -32000 || err.code === -32001 || err.code >= 500;
      if (transport) console.error('[stake-trade]', items.map(i => i.action).join(','), err.message);
      return json({
        ok: false,
        error: transport ? 'The wallet service is unavailable. Check that all services are running.' : err.message,
        code_consumed: true,
        completed: results.length,
      }, 502);
    }
    console.error('[stake-trade]', items.map(i => i.action).join(','), err);
    return json({ ok: false, error: 'Operation failed', code_consumed: true, completed: results.length }, 500);
  }
};
