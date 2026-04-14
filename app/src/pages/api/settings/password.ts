import type { APIRoute } from 'astro';
import { verifyPassword, hashPassword } from '@/lib/auth';
import { getStringPref, setPref } from '@/lib/prefs-db';

export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }

  const currentPassword = (form.get('current_password') as string | null) ?? '';
  const newPassword     = (form.get('new_password')     as string | null) ?? '';
  const confirmPassword = (form.get('confirm_password') as string | null) ?? '';

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

  return json({ ok: true }, 200);
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
