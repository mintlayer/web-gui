import type { APIRoute } from 'astro';
import { verifyPassword, hashPassword } from '@/lib/auth';
import { getStringPref, getPref, setPref } from '@/lib/prefs-db';

export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  // form.get() returns string | File | null; a File part would bypass the length
  // check and crash hashPassword. Coerce non-strings to '' so they fail cleanly.
  const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');
  const currentPassword = str(form.get('current_password'));
  const newPassword     = str(form.get('new_password'));
  const confirmPassword = str(form.get('confirm_password'));

  const storedHash = getStringPref('auth.password_hash');
  if (!storedHash) {
    return json({ ok: false, error: 'Password not configured' }, 400);
  }

  const currentOk = await verifyPassword(currentPassword, storedHash);
  if (!currentOk) {
    return json({ ok: false, error: 'Current password is incorrect' }, 401);
  }

  if (newPassword.length < 8) {
    return json({ ok: false, error: 'New password must be at least 8 characters' }, 400);
  }

  if (newPassword !== confirmPassword) {
    return json({ ok: false, error: 'New passwords do not match' }, 400);
  }

  const newHash = await hashPassword(newPassword);
  setPref('auth.password_hash', newHash);
  const currentVersion = getPref<number>('auth.session_version') ?? 0;
  setPref('auth.session_version', currentVersion + 1);

  return json({ ok: true }, 200);
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
