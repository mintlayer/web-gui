import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { requireStepUp, totpFromBody } from '@/lib/step-up';
import {
  isFeatureEnablerAvailable,
  isRequestPending,
  queueFeatureRequest,
  RELEASE_TAG_RE,
  BITCOIND_VERSION_RE,
} from '@/lib/feature-requests';

/**
 * POST /api/features/upgrade - queue a whole-stack upgrade to a release tag
 * for the feature-enabler sidecar. The sidecar pulls every image BEFORE
 * touching .env (a failed pull changes nothing), then restarts daemons and
 * finally web-gui - this API's own container, hence the async request-file
 * transport.
 *
 * The tag is validated here and re-validated by the sidecar: the volume is
 * a trust boundary. A missing/invalid `bitcoind` field is fine - releases
 * without the `bitcoind:` marker never touch Bitcoin Core.
 */
export const POST: APIRoute = async ({ request, clientAddress }) => {
  const available = await isFeatureEnablerAvailable();
  if (!available) {
    return json(
      {
        ok: false,
        error:
          'Upgrades are managed from the host on this install (docker compose pull && docker compose up -d)',
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

  const tag = typeof body.tag === 'string' ? body.tag : '';
  if (!RELEASE_TAG_RE.test(tag) || tag.length > 40) {
    return json({ ok: false, error: 'A valid release tag is required' }, 400);
  }
  if (body.bitcoind !== undefined) {
    const bitcoind = typeof body.bitcoind === 'string' ? body.bitcoind : '';
    if (!BITCOIND_VERSION_RE.test(bitcoind)) {
      return json({ ok: false, error: 'Invalid Bitcoin Core version' }, 400);
    }
  }
  if (await isRequestPending('web-gui')) {
    return json({ ok: false, error: 'An upgrade request is already queued' }, 409);
  }

  const stepUp = requireStepUp(totpFromBody(body), request, clientAddress as string | undefined);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  if (
    !(await queueFeatureRequest({
      action: 'upgrade',
      service: 'web-gui',
      tag,
      ...(typeof body.bitcoind === 'string' ? { bitcoind: body.bitcoind } : {}),
    }))
  ) {
    return json({ ok: false, error: 'An upgrade request is already queued' }, 409);
  }

  return json({ ok: true, queued: true, service: 'web-gui' }, 202);
};
