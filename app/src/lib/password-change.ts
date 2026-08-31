/**
 * Password-change decision logic, extracted from the duplicated
 * implementations in /api/settings/password.ts and the Management → Settings
 * page (resolveMcpSettings pattern) so the rules are unit-testable and both
 * entry points stay in lockstep.
 */
import { verifyPassword, hashPassword } from '@/lib/auth';
import { getStringPref, getPref, setPref } from '@/lib/prefs-db';

export interface PasswordChangeInput {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export type PasswordChangeDecision =
  | { ok: true; newHash: string }
  | { ok: false; error: string; httpStatus: number };

/**
 * Validate a password change against the stored hash. Does not persist
 * anything - call applyPasswordChange() with the returned hash afterwards
 * so callers keep control over response handling.
 */
export async function resolvePasswordChange(
  input: PasswordChangeInput,
): Promise<PasswordChangeDecision> {
  const storedHash = getStringPref('auth.password_hash');
  if (!storedHash) {
    return { ok: false, error: 'Password not configured', httpStatus: 400 };
  }

  const currentOk = await verifyPassword(input.currentPassword, storedHash);
  if (!currentOk) {
    return { ok: false, error: 'Current password is incorrect', httpStatus: 401 };
  }

  if (input.newPassword.length < 8) {
    return { ok: false, error: 'New password must be at least 8 characters', httpStatus: 400 };
  }

  if (input.newPassword !== input.confirmPassword) {
    return { ok: false, error: 'New passwords do not match', httpStatus: 400 };
  }

  return { ok: true, newHash: await hashPassword(input.newPassword) };
}

/**
 * Persist a resolved password change: store the new hash and bump the session
 * version so every existing session token is invalidated.
 */
export function applyPasswordChange(newHash: string): void {
  setPref('auth.password_hash', newHash);
  const currentVersion = getPref<number>('auth.session_version') ?? 0;
  setPref('auth.session_version', currentVersion + 1);
}
