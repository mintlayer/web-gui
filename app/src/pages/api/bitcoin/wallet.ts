import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { isBitcoinEnabled, createBitcoinWallet } from '@/lib/bitcoin-wallet';

/**
 * POST /api/bitcoin/wallet - create (or restore) the BTC wallet.
 *
 * The mnemonic is returned EXACTLY ONCE, on creation; the sidecar persists it
 * server-side and never serves it again. Clients must present the backup step
 * immediately after a successful create.
 */
export const POST: APIRoute = async ({ request }) => {
  if (!isBitcoinEnabled()) {
    return json({ ok: false, error: 'Bitcoin support is not enabled' }, 404);
  }

  let seed: string | undefined;
  try {
    const body = (await request.json()) as { seed?: unknown };
    if (typeof body.seed === 'string' && body.seed.trim() !== '') {
      seed = body.seed;
    }
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  try {
    const result = await createBitcoinWallet(seed);
    return json(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return json({ ok: false, error: (err as Error).message }, status === 503 ? 503 : 409);
  }
};
