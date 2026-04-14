import type { APIRoute } from 'astro';
import { verifyTOTP, generateTotpSecret } from '@/lib/auth';
import { getStringPref, setPref } from '@/lib/prefs-db';

export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  const totpCode = (form.get('totp_code') as string | null) ?? '';

  const currentSecret = getStringPref('auth.totp_secret');
  if (!currentSecret) {
    return json({ ok: false, error: '2FA not configured' }, 400);
  }

  if (!verifyTOTP(totpCode, currentSecret)) {
    return json({ ok: false, error: 'Invalid authenticator code' }, 401);
  }

  const newSecret = generateTotpSecret();
  setPref('auth.totp_secret', newSecret);

  const label = encodeURIComponent('Mintlayer GUI-X');
  const issuer = encodeURIComponent('Mintlayer');
  const uri = `otpauth://totp/${label}?secret=${newSecret}&issuer=${issuer}`;

  return json({ ok: true, secret: newSecret, uri }, 200);
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
