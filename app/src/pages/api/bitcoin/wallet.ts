import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { isBitcoinEnabled, createBitcoinWallet } from '@/lib/bitcoin-wallet';
import { requireStepUp, totpFromBody } from '@/lib/step-up';

/**
 * POST /api/bitcoin/wallet - create (or restore) the BTC wallet.
 *
 * Key-material lifecycle endpoint: requires a fresh, single-use TOTP code
 * (step-up) in addition to the session cookie.
 *
 * The mnemonic is returned EXACTLY ONCE, on creation; the sidecar persists it
 * server-side and never serves it again (restore responses omit it). Clients
 * must present the backup step immediately after a successful create.
 */
export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!isBitcoinEnabled()) {
    return json({ ok: false, error: 'Bitcoin support is not enabled' }, 404);
  }

  let seed: string | undefined;
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
    if (typeof body.seed === 'string' && body.seed.trim() !== '') {
      seed = body.seed;
    }
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  const stepUp = requireStepUp(totpFromBody(body), request, clientAddress as string | undefined);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  try {
    const result = await createBitcoinWallet(seed);
    return json(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return json({ ok: false, error: (err as Error).message }, status === 503 ? 503 : status === 409 ? 409 : 400);
  }
};
