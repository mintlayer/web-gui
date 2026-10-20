import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { requireStepUp, totpFromBody } from '@/lib/step-up';
import {
  CURRENT_VERSION,
  checkForUpdate,
  clearUpdateCache,
  type UpdateStatus,
} from '@/lib/update-check';
import {
  isAutoInstallEnabled,
  isIncludePrereleasesEnabled,
  setAutoInstallEnabled,
  setIncludePrereleasesEnabled,
} from '@/lib/update-prefs';
import {
  isFeatureEnablerAvailable,
  isRequestPending,
  queueFeatureRequest,
  readFeatureResult,
} from '@/lib/feature-requests';

/**
 * GET /api/update-check - newest release vs the running version.
 *
 * Read-only against api.github.com (no wallet or usage data leaves the
 * host), cached in-module for hours. When auto-install is on and a newer
 * applicable release exists, the upgrade is queued here - the enabler
 * sidecar pulls images before touching .env and restarts the stack (the
 * web UI briefly becomes unreachable while its own container is replaced).
 *
 * POST - turn auto-install on/off. Requires fresh step-up TOTP: the toggle
 * is the trust anchor for all future unattended upgrades.
 */
const UNAVAILABLE: UpdateStatus = {
  current: '',
  available: false,
  latest: null,
  checkedAt: null,
};

export const GET: APIRoute = async () => {
  const includePrereleases = isIncludePrereleasesEnabled();
  let update: UpdateStatus = { ...UNAVAILABLE };
  let error: string | undefined;
  try {
    update = await checkForUpdate(includePrereleases);
  } catch {
    // GitHub unreachable / rate limited: degrade honestly, never block the UI.
    update.current = CURRENT_VERSION;
    error = 'release check unavailable';
  }

  let autoQueued = false;
  if (update.available && isAutoInstallEnabled() && update.latest) {
    try {
      const lastResult = await readFeatureResult('web-gui');
      // No auto-retry: once an upgrade has failed on this install, auto
      // stays quiet until someone acts (a manual upgrade from the settings
      // card always remains possible).
      if (
        (await isFeatureEnablerAvailable()) &&
        !(await isRequestPending('web-gui')) &&
        lastResult?.ok !== false
      ) {
        autoQueued = await queueFeatureRequest({
          action: 'upgrade',
          service: 'web-gui',
          tag: update.latest.tag,
          ...(update.latest.bitcoind ? { bitcoind: update.latest.bitcoind } : {}),
        });
      }
    } catch {
      autoQueued = false;
    }
  }

  return json({
    ok: true,
    update,
    error,
    autoInstall: isAutoInstallEnabled(),
    includePrereleases,
    autoQueued,
  });
};

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }
  if (typeof body.auto_install !== 'boolean') {
    return json({ ok: false, error: 'auto_install must be true or false' }, 400);
  }
  if (body.include_prereleases !== undefined && typeof body.include_prereleases !== 'boolean') {
    return json({ ok: false, error: 'include_prereleases must be true or false' }, 400);
  }

  const stepUp = requireStepUp(totpFromBody(body), request, clientAddress as string | undefined);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  setAutoInstallEnabled(body.auto_install);
  if (typeof body.include_prereleases === 'boolean') {
    setIncludePrereleasesEnabled(body.include_prereleases);
    // The cached feed was filtered with the old preference.
    clearUpdateCache();
  }
  return json({ ok: true, autoInstall: body.auto_install });
};
