/**
 * POST /api/wallet-open
 * Attempts to open /home/mintlayer/mintlayer.wallet (no password).
 * Returns { ok, status } where status is one of:
 *   'opened'         — wallet opened successfully
 *   'needs_password' — wallet file exists but is encrypted
 *   'not_found'      — wallet file does not exist
 *   'already_open'   — wallet was already open (treated as success)
 *   'error'          — unexpected failure (message included)
 */

import type { APIRoute } from 'astro';
import { ensureWalletOpen, isWalletNotOpenError, walletInfo } from '@/lib/wallet-rpc';

export const POST: APIRoute = async () => {
  // Check if already open — if so, nothing to do
  try {
    await walletInfo();
    console.log('[wallet] wallet already open');
    return json({ ok: true, status: 'already_open' });
  } catch (alreadyErr) {
    if (!isWalletNotOpenError(alreadyErr)) {
      // Daemon unreachable or some other hard error — surface it
      console.error('[wallet] wallet-open pre-check failed:', (alreadyErr as Error).message);
      return json({ ok: false, status: 'error', message: (alreadyErr as Error).message });
    }
    // "No wallet opened" — proceed to open
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
  return json({ ok: false, status: 'error', message: result.message });
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}
