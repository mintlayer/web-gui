import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { isBitcoinEnabled, createBitcoinWalletFromSeedWithRetry } from '@/lib/bitcoin-wallet';
import { requireStepUp, totpFromBody } from '@/lib/step-up';
import {
  walletShowSeedPhrase,
  walletUnlockPrivateKeys,
  walletLockPrivateKeys,
  isWalletNotOpenError,
} from '@/lib/wallet-rpc';

/**
 * POST /api/bitcoin/link-seed - derive the BTC wallet from the Mintlayer
 * wallet's own seed ("one seed, both chains") for stacks where the bitcoin
 * profile was enabled after setup (the setup flow already links at birth).
 *
 * The seed phrase is read server-side and NEVER leaves this process: it is
 * fetched from wallet-rpc, handed straight to the BTC sidecar and dropped.
 * It is not echoed in responses, not logged, and never sent to the browser.
 *
 * Key-material lifecycle endpoint: requires the session, a fresh single-use
 * TOTP code (step-up) AND the wallet password (private keys must be unlocked
 * to reveal the seed). Private keys are re-locked when this handler exits,
 * success or failure.
 */
export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!isBitcoinEnabled()) {
    return json({ ok: false, error: 'Bitcoin support is not enabled' }, 404);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  const stepUp = requireStepUp(totpFromBody(body), request, clientAddress as string | undefined);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (password === '') {
    return json({ ok: false, error: 'Your Mintlayer wallet password is required' }, 400);
  }

  let seed = '';
  try {
    try {
      await walletUnlockPrivateKeys(password);
    } catch (err) {
      if (/password|passphrase/i.test((err as Error).message)) {
        return json({ ok: false, error: 'Wrong wallet password' }, 403);
      }
      // Already-unlocked and similar states are not fatal here — the
      // reveal below is the authority on whether the keys are readable.
    }

    try {
      const res = await walletShowSeedPhrase();
      if (!res || !Array.isArray(res.seed_phrase) || res.seed_phrase.length === 0) {
        return json(
          { ok: false, error: 'No seed phrase available — create or recover your Mintlayer wallet first' },
          409,
        );
      }
      seed = res.seed_phrase.join(' ');
    } catch (err) {
      const msg = (err as Error).message;
      if (/lock/i.test(msg)) {
        return json({ ok: false, error: 'Could not unlock the wallet — check the password' }, 403);
      }
      if (isWalletNotOpenError(err)) {
        return json({ ok: false, error: 'Open your Mintlayer wallet first' }, 409);
      }
      throw err;
    }
  } finally {
    // Re-lock no matter which path we take — keep the unlocked window
    // as short as possible even on the failure paths.
    await walletLockPrivateKeys().catch(() => {});
  }

  try {
    // No scan_from: this seed may be old — the sidecar scans from block 0
    // so BTC received before the link is not missed.
    const result = await createBitcoinWalletFromSeedWithRetry(seed);
    return json(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return json(
      { ok: false, error: (err as Error).message },
      status === 503 ? 503 : status === 409 ? 409 : 400,
    );
  }
};
