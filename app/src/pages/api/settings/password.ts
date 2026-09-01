import type { APIRoute } from 'astro';
import { resolvePasswordChange, applyPasswordChange } from '@/lib/password-change';
import { json, readFormData } from '@/lib/api-utils';

export const POST: APIRoute = async ({ request }) => {
  const form = await readFormData(request);
  if (!form) return json({ ok: false, error: 'Invalid request body' }, 400);

  // form.get() returns string | File | null; a File part would bypass the length
  // check and crash hashPassword. Coerce non-strings to '' so they fail cleanly.
  const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');
  const decision = await resolvePasswordChange({
    currentPassword: str(form.get('current_password')),
    newPassword:     str(form.get('new_password')),
    confirmPassword: str(form.get('confirm_password')),
  });

  if (!decision.ok) {
    return json({ ok: false, error: decision.error }, decision.httpStatus);
  }

  applyPasswordChange(decision.newHash);
  return json({ ok: true }, 200);
};
