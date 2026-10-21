/**
 * POST /api/wallet-open
 * Attempts to open /home/mintlayer/mintlayer.wallet (no password).
 * Returns { ok, status } where status is one of:
 *   'opened'         - wallet opened successfully
 *   'needs_password' - wallet file exists but is encrypted
 *   'not_found'      - wallet file does not exist
 *   'already_open'   - wallet was already open (treated as success)
 *   'error'          - unexpected failure (message included)
 */

import type { APIRoute } from 'astro';
import { ensureWalletOpen, isWalletNotOpenError, walletInfo, WalletRpcError } from '@/lib/wallet-rpc';
import { json } from '@/lib/api-utils';

/** Redaction parity with /api/rpc: transport-band codes (-32000/-32001) and
 * HTTP-status errors carry the daemon URL / internal details, so they become
 * the generic unavailable copy instead of being forwarded to the browser. */
function browserSafeOpenError(err: unknown): string {
  const code = err instanceof WalletRpcError ? err.code : undefined;
  const forwardable =
    err instanceof WalletRpcError &&
    typeof code === 'number' &&
    code !== -32000 && code !== -32001 && code < 0 &&
    (code === -1 || (code >= -32700 && code <= -32002));
  return forwardable
    ? (err as WalletRpcError).message
    : 'The wallet service is unavailable. Check that all services are running.';
}

export const POST: APIRoute = async () => {
  // Check if already open - if so, nothing to do
  try {
    await walletInfo();
    console.log('[wallet] wallet already open');
    return json({ ok: true, status: 'already_open' });
  } catch (alreadyErr) {
    if (!isWalletNotOpenError(alreadyErr)) {
      // Daemon unreachable or some other hard error - log the detail, give
      // the browser the redacted copy (never the raw daemon URL).
      console.error('[wallet] wallet-open pre-check failed:', (alreadyErr as Error).message);
      return json({ ok: false, status: 'error', message: browserSafeOpenError(alreadyErr) });
    }
    // "No wallet opened" - proceed to open
    console.log('[wallet] no wallet open, attempting auto-open...');
  }

  const result = await ensureWalletOpen();
  if (result.status === 'ok') {
    return json({ ok: true, status: 'opened' });
  }
  if (result.status === 'needs_password') {
    return json({ ok: false, status: 'needs_password' });
  }
  if (result.status === 'not_found') {
    return json({ ok: false, status: 'not_found' });
  }
  return json({ ok: false, status: 'error', message: browserSafeOpenError(result.error) });
};
