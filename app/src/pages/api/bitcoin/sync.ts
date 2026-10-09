import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { isBitcoinEnabled, triggerBitcoinSync } from '@/lib/bitcoin-wallet';

/** POST /api/bitcoin/sync - ask the sidecar to resync the wallet. */
export const POST: APIRoute = async () => {
  if (!isBitcoinEnabled()) {
    return json({ ok: false, error: 'Bitcoin support is not enabled' }, 404);
  }
  try {
    return json(await triggerBitcoinSync());
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return json({ ok: false, error: (err as Error).message }, status);
  }
};
