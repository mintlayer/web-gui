import type { APIRoute } from 'astro';
import { generateTotpSecret } from '@/lib/auth';
import { verifyAndBurnTotpCode } from '@/lib/step-up';
import { getStringPref, setPref } from '@/lib/prefs-db';
import { json, readFormData } from '@/lib/api-utils';

export const POST: APIRoute = async ({ request }) => {
  const form = await readFormData(request);
  if (!form) return json({ ok: false, error: 'Invalid request body' }, 400);

  const totpCode = (form.get('totp_code') as string | null) ?? '';

  const currentSecret = getStringPref('auth.totp_secret');
  if (!currentSecret) {
    return json({ ok: false, error: '2FA not configured' }, 400);
  }

  const burn = verifyAndBurnTotpCode(totpCode, currentSecret);
  if (!burn.ok) {
    return json({ ok: false, error: burn.error }, 401);
  }

  const newSecret = generateTotpSecret();
  setPref('auth.totp_secret', newSecret);

  const label = encodeURIComponent('Mintlayer GUI-X');
  const issuer = encodeURIComponent('Mintlayer');
  const uri = `otpauth://totp/${label}?secret=${newSecret}&issuer=${issuer}`;

  return json({ ok: true, secret: newSecret, uri }, 200);
};
