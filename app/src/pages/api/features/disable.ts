import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { requireStepUp, totpFromBody } from '@/lib/step-up';
import {
  isFeatureEnablerAvailable,
  isFeatureService,
  isRequestPending,
  queueFeatureRequest,
} from '@/lib/feature-requests';
import { isBitcoinEnabled } from '@/lib/bitcoin-wallet';

/**
 * POST /api/features/disable — queue an optional-service stop (bitcoin or
 * indexer profile) for the feature-enabler sidecar. Requires the session
 * plus a fresh single-use TOTP: stopping services is disruptive (the BTC
 * wallet stops tracking funds, indexed data goes stale).
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
  if (service === 'bitcoin' && !isBitcoinEnabled()) {
    return json({ ok: false, error: 'Bitcoin is not enabled' }, 409);
  }
  if (service === 'indexer' && process.env.INDEXER_ENABLED !== 'true') {
    return json({ ok: false, error: 'The indexer is not enabled' }, 409);
  }
  if (await isRequestPending(service)) {
    return json({ ok: false, error: 'A request for this service is already queued' }, 409);
  }

  const stepUp = requireStepUp(totpFromBody(body), request, clientAddress as string | undefined);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  if (!(await queueFeatureRequest({ action: 'disable', service }))) {
    return json({ ok: false, error: 'A request for this service is already queued' }, 409);
  }
  return json({ ok: true, queued: true, service }, 202);
};
