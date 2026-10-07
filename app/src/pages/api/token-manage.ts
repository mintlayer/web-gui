import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { rpcCall, WalletRpcError } from '@/lib/wallet-rpc';
import { requireStepUp, totpFromBody } from '@/lib/step-up';
import { isValidAmount } from '@/lib/validation';

/**
 * POST /api/token-manage - TOTP-gated token/NFT authority operations.
 *
 * Authority endpoint: issuing, minting, unminting, locking supply, freezing,
 * unfreezing, changing authority and changing metadata all mutate on-chain
 * token state (several irreversibly) and burn fees — they require a fresh TOTP
 * code (step-up) on top of the session cookie, exactly like /api/send. These
 * methods are intentionally absent from the browser/plugin RPC allowlist, so
 * this is the only path — a stolen session cookie alone cannot mint, freeze,
 * or reassign a token.
 *
 * Every action has a strict per-action parameter whitelist validated BEFORE
 * the TOTP code is burned, so knowable failures never consume a code.
 * The daemon remains the authoritative validator for chain-level semantics
 * (address checksums, supply math, freeze state).
 */

type Params = Record<string, unknown>;

const ACTIONS = new Set([
  'token_issue_new',
  'token_nft_issue_new',
  'token_mint',
  'token_unmint',
  'token_lock_supply',
  'token_freeze',
  'token_unfreeze',
  'token_change_authority',
  'token_change_metadata_uri',
]);

// Charset/length bounds for chain identifiers and addresses. The daemon
// validates semantics (checksum, network prefix); this only stops garbage
// before a code is burned.
const ID_RE = /^[a-z0-9]{10,120}$/i;
const HEX_RE = /^[0-9a-fA-F]*$/;
const TICKER_RE = /^[A-Za-z0-9]{1,5}$/;

function isStr(v: unknown, re: RegExp): boolean {
  return typeof v === 'string' && re.test(v);
}

function isObj(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Optional URI fields arrive either as '' (unset) or { hex: '...' }
function isHexField(v: unknown): boolean {
  return v === '' || v === null || (isObj(v) && isStr((v as Params).hex, HEX_RE));
}

function isAmountField(v: unknown): boolean {
  return isObj(v) && typeof (v as Params).decimal === 'string' &&
    isValidAmount((v as Params).decimal as string, 18);
}

function validateParams(action: string, p: Params): string | null {
  const opts = 'options' in p && p.options !== undefined ? (isObj(p.options) ? null : 'options must be an object') : null;
  if (opts) return opts;

  switch (action) {
    case 'token_issue_new': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.destination_address, ID_RE)) return 'destination_address is required';
      if (!isObj(p.metadata)) return 'metadata is required';
      const m = p.metadata as Params;
      if (!isStr(m.token_ticker, TICKER_RE)) return 'ticker must be 1-5 letters/digits';
      const d = m.number_of_decimals;
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 18) return 'number_of_decimals must be 0-18';
      if (!isHexField(m.metadata_uri)) return 'metadata_uri is invalid';
      if (typeof m.is_freezable !== 'boolean') return 'is_freezable must be a boolean';
      const supply = m.token_supply;
      if (supply !== undefined && supply !== null) {
        if (!isObj(supply)) return 'token_supply is invalid';
        const s = supply as Params;
        if (s.type === 'Fixed') {
          if (!isAmountField(s.content)) return 'token_supply amount is invalid';
        } else if (typeof s.type !== 'string') {
          return 'token_supply type is invalid';
        }
      }
      return null;
    }
    case 'token_nft_issue_new': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.destination_address, ID_RE)) return 'destination_address is required';
      if (!isObj(p.metadata)) return 'metadata is required';
      const m = p.metadata as Params;
      if (typeof m.media_hash !== 'string' || m.media_hash.length > 64) return 'media_hash is invalid';
      if (typeof m.name !== 'string' || m.name.length > 200) return 'name is invalid';
      if (m.description !== null && typeof m.description !== 'string') return 'description is invalid';
      if (m.ticker !== null && typeof m.ticker !== 'string') return 'ticker is invalid';
      if (m.creator !== null) return 'creator must be null';
      if (!isHexField(m.icon_uri) || !isHexField(m.media_uri) || !isHexField(m.additional_metadata_uri)) {
        return 'metadata URIs are invalid';
      }
      return null;
    }
    case 'token_mint': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.token_id, ID_RE)) return 'token_id is required';
      if (!isStr(p.address, ID_RE)) return 'address is required';
      if (!isAmountField(p.amount)) return 'amount is invalid';
      return null;
    }
    case 'token_unmint': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.token_id, ID_RE)) return 'token_id is required';
      if (!isAmountField(p.amount)) return 'amount is invalid';
      return null;
    }
    case 'token_lock_supply': {
      if (p.account_index !== 0) return 'account_index must be 0';
      if (!isStr(p.token_id, ID_RE)) return 'token_id is required';
      return null;
    }
    case 'token_freeze': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.token_id, ID_RE)) return 'token_id is required';
      if (typeof p.is_unfreezable !== 'boolean') return 'is_unfreezable must be a boolean';
      return null;
    }
    case 'token_unfreeze': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.token_id, ID_RE)) return 'token_id is required';
      return null;
    }
    case 'token_change_authority': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.token_id, ID_RE)) return 'token_id is required';
      if (!isStr(p.address, ID_RE)) return 'address is required';
      return null;
    }
    case 'token_change_metadata_uri': {
      if (p.account !== 0) return 'account must be 0';
      if (!isStr(p.token_id, ID_RE)) return 'token_id is required';
      if (!isHexField(p.metadata_uri)) return 'metadata_uri is invalid';
      return null;
    }
    default:
      return 'Unknown action';
  }
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let action = '';
  let params: Params = {};
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
    if (typeof body.action === 'string') action = body.action;
    if (isObj(body.params)) params = body.params as Params;
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  if (!ACTIONS.has(action)) {
    return json({ ok: false, error: 'Unknown action' }, 400);
  }

  // Validate BEFORE burning the code: a knowable 400 must not cost the user
  // their authenticator code (same ordering as the bridge intent endpoint).
  const invalid = validateParams(action, params);
  if (invalid) {
    return json({ ok: false, error: invalid }, 400);
  }

  const stepUp = requireStepUp(totpFromBody(body), request, clientAddress as string | undefined);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  try {
    const result = await rpcCall<Record<string, unknown>>(action, params);
    return json({ ok: true, result });
  } catch (err) {
    // Step-up already ran: the TOTP code is burned even though nothing was
    // submitted. Flag it so the UI can ask for a FRESH code instead of the
    // user silently retrying the dead one.
    if (err instanceof WalletRpcError) {
      return json({ ok: false, error: err.message, code_consumed: true }, 502);
    }
    console.error('[token-manage]', action, err);
    return json({ ok: false, error: 'Token operation failed', code_consumed: true }, 500);
  }
};
