import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { requireStepUp, totpFromBody } from '@/lib/step-up';
import {
  isBitcoinNetwork,
  isFeatureEnablerAvailable,
  isFeatureService,
  isRequestPending,
  queueFeatureRequest,
} from '@/lib/feature-requests';
import { isBitcoinEnabled } from '@/lib/bitcoin-wallet';

/**
 * POST /api/features/enable - queue an optional-service start (bitcoin or
 * indexer profile) for the feature-enabler sidecar. The compose work happens
 * asynchronously outside this process; the UI follows up by polling
 * /api/features/status and the service health endpoints.
 *
 * Auth: session (middleware) + fresh single-use TOTP. Starting a profile has
 * real host impact (the bitcoin node can pull hundreds of GB), so a stolen
 * session alone must not be able to trigger it.
 */
export const POST: APIRoute = async ({ request, clientAddress }) => {
  const available = await isFeatureEnablerAvailable();
  if (!available) {
    return json(
      {
        ok: false,
        error:
          'Optional services are managed from the host on this install (docker compose --profile <name> up -d)',
      },
      503,
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  if (!isFeatureService(body.service)) {
    return json({ ok: false, error: 'Unknown service' }, 400);
  }
  const service = body.service;

  // Current-state checks come before step-up: /api/features/status already
  // exposes this state to any signed-in session, so burning a fresh TOTP for
  // a redundant click would only hurt.
  if (service === 'bitcoin' && isBitcoinEnabled()) {
    return json({ ok: false, error: 'Bitcoin is already enabled' }, 409);
  }
  if (service === 'indexer' && process.env.INDEXER_ENABLED === 'true') {
    return json({ ok: false, error: 'The indexer is already enabled' }, 409);
  }
  if (await isRequestPending(service)) {
    return json({ ok: false, error: 'A request for this service is already queued' }, 409);
  }

  const stepUp = requireStepUp(totpFromBody(body), request, clientAddress as string | undefined);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  if (service === 'bitcoin') {
    const network = body.network === undefined ? 'mainnet' : body.network;
    if (!isBitcoinNetwork(network)) {
      return json({ ok: false, error: 'Network must be mainnet, testnet or regtest' }, 400);
    }
    if (!(await queueFeatureRequest({ action: 'enable', service, network, pruned: body.pruned !== false }))) {
      return json({ ok: false, error: 'A request for this service is already queued' }, 409);
    }
  } else {
    if (!(await queueFeatureRequest({ action: 'enable', service }))) {
      return json({ ok: false, error: 'A request for this service is already queued' }, 409);
    }
  }

  return json({ ok: true, queued: true, service }, 202);
};
