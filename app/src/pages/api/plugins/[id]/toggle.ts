import type { APIRoute } from 'astro';
import { togglePlugin } from '@/lib/plugins';
import { getClientAddress } from '@/lib/auth';
import { verifyAndBurnTotpCode } from '@/lib/step-up';
import { getStringPref } from '@/lib/prefs-db';
import { json } from '@/lib/api-utils';

export const POST: APIRoute = async ({ params, request, clientAddress }) => {
  const id = params.id ?? '';

  let body: { enabled?: unknown; totp_code?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.enabled !== 'boolean') {
    return json({ ok: false, error: '"enabled" must be a boolean' }, 400);
  }

  // Enabling activates dormant plugin code (its page becomes reachable and the
  // unsandboxed handler runs) — the same step as installing, so it needs the
  // same fresh 2FA code. Disabling only reduces capability: session is enough.
  if (body.enabled) {
    const totpCode = typeof body.totp_code === 'string' ? body.totp_code : '';
    const totpSecret = getStringPref('auth.totp_secret');
    if (!totpSecret) {
      return json({ ok: false, error: '2FA not configured' }, 400);
    }
    const burn = verifyAndBurnTotpCode(totpCode, totpSecret, getClientAddress(request, clientAddress));
    if (!burn.ok) {
      return json({ ok: false, error: burn.error }, 401);
    }
  }

  try {
    togglePlugin(id, body.enabled);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 422);
  }
};
