import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { requireStepUp, totpFromBody } from '@/lib/step-up';
import {
  isFeatureEnablerAvailable,
  isRequestPending,
  queueFeatureRequest,
} from '@/lib/feature-requests';

/**
 * POST /api/features/rollback — restore the image pins the sidecar saved
 * before the last upgrade (PREVIOUS_* anchors in .env). Fails honestly via
 * the result file when no upgrade has ever run on this install.
 */
export const POST: APIRoute = async ({ request, clientAddress }) => {
  const available = await isFeatureEnablerAvailable();
  if (!available) {
    return json(
      {
        ok: false,
        error:
          'Rollbacks are managed from the host on this install (restore the image pins in .env)',
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

  if (await isRequestPending('web-gui')) {
    return json({ ok: false, error: 'A request for this service is already queued' }, 409);
  }

  const stepUp = requireStepUp(totpFromBody(body), request, clientAddress as string | undefined);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  if (!(await queueFeatureRequest({ action: 'rollback', service: 'web-gui' }))) {
    return json({ ok: false, error: 'A request for this service is already queued' }, 409);
  }

  return json({ ok: true, queued: true, service: 'web-gui' }, 202);
};
