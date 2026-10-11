import type { APIRoute } from 'astro';
import { generateTotpSecret, getClientAddress } from '@/lib/auth';
import { verifyAndBurnTotpCode } from '@/lib/step-up';
import { getStringPref, setPref } from '@/lib/prefs-db';
import { json, readFormData } from '@/lib/api-utils';

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const form = await readFormData(request);
  if (!form) return json({ ok: false, error: 'Invalid request body' }, 400);

  // Coerce non-strings (e.g. File parts) to '' so they fail validation cleanly
  // instead of crashing hash-style checks downstream.
  const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');
  const totpCode = str(form.get('totp_code'));

  const currentSecret = getStringPref('auth.totp_secret');
  if (!currentSecret) {
    return json({ ok: false, error: '2FA not configured' }, 400);
  }

  // throttleKey: failed TOTP attempts from one address lock out after 5 —
  // this endpoint returns the NEW secret on success, so an unthrottled
  // guess loop is a 2FA takeover primitive.
  const burn = verifyAndBurnTotpCode(totpCode, currentSecret, getClientAddress(request, clientAddress));
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
