import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import {
  isFeatureEnablerAvailable,
  isRequestPending,
  readFeatureResult,
  FEATURE_SERVICES,
  type FeatureService,
} from '@/lib/feature-requests';
import { isBitcoinEnabled } from '@/lib/bitcoin-wallet';

/**
 * GET /api/features/status — enablement state for the optional services
 * (bitcoin, indexer), whether the enabler sidecar is wired into this
 * install, queued requests and the last apply results.
 *
 * Light by design: no daemon probes here (the bitcoin reachability comes
 * from /api/bitcoin/overview, the indexer from /api/indexer-status).
 */
export const GET: APIRoute = async () => {
  const available = await isFeatureEnablerAvailable();

  const services: Record<
    string,
    { enabled: boolean; pending: boolean; lastResult: Awaited<ReturnType<typeof readFeatureResult>> }
  > = {};
  for (const service of FEATURE_SERVICES as readonly FeatureService[]) {
    const enabled =
      service === 'bitcoin' ? isBitcoinEnabled() : process.env.INDEXER_ENABLED === 'true';
    services[service] = {
      enabled,
      pending: await isRequestPending(service),
      lastResult: await readFeatureResult(service),
    };
  }

  return json({ ok: true, available, services });
};
