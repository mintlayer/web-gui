import type { APIRoute } from 'astro';
import { uninstallPlugin } from '@/lib/plugins';
import { getClientAddress } from '@/lib/auth';
import { verifyAndBurnTotpCode } from '@/lib/step-up';
import { getStringPref } from '@/lib/prefs-db';
import { json } from '@/lib/api-utils';

export const POST: APIRoute = async ({ params, request, clientAddress }) => {
  const id = params.id ?? '';

  // Step-up auth: uninstalling destroys plugin files and state.
  // Accept the TOTP code from form data or a JSON body.
  let totpCode = '';
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as { totp_code?: unknown };
      totpCode = typeof body.totp_code === 'string' ? body.totp_code : '';
    } else if (contentType) {
      const form = await request.formData();
      totpCode = typeof form.get('totp_code') === 'string' ? (form.get('totp_code') as string) : '';
    }
  } catch {
    // fall through with empty code - verification below rejects it
  }

  const totpSecret = getStringPref('auth.totp_secret');
  if (!totpSecret) {
    return json({ ok: false, error: '2FA not configured' }, 400);
  }
  const burn = verifyAndBurnTotpCode(totpCode, totpSecret, getClientAddress(request, clientAddress));
  if (!burn.ok) {
    return json({ ok: false, error: burn.error }, 401);
  }

  try {
    uninstallPlugin(id);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 422);
  }
};
