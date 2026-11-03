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

// ── Failed current-password throttle ────────────────────────────────────────
// Login throttles wrong passwords per IP, so password change must too: a
// hijacked session would otherwise brute-force the current password online
// at PBKDF2 speed and lock the owner out permanently. Mirrors the TOTP
// throttle in step-up.ts: 5 failures per key per 15 minutes.

const MAX_PASSWORD_FAILURES = 5;
const PASSWORD_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const passwordFailures = new Map<string, { count: number; firstAt: number }>();

export function isPasswordChangeThrottled(key: string, now: number = Date.now()): boolean {
  const entry = passwordFailures.get(key);
  return (
    !!entry &&
    entry.count >= MAX_PASSWORD_FAILURES &&
    now < entry.firstAt + PASSWORD_FAILURE_WINDOW_MS
  );
}

/** Test hook: clear all throttles (module state survives across tests). */
export function resetPasswordChangeThrottle(): void {
  passwordFailures.clear();
}

/**
 * Record a failed credential attempt against a throttle key. The wallet
 * unlock form shares this map (under its own key namespace) - the unlock
 * password is the same class of guessable secret as the current-password
 * check, and RPC speed alone is no rate limit.
 */
export function recordThrottledFailure(key: string, now: number = Date.now()): void {
  recordPasswordFailure(key, now);
}

function recordPasswordFailure(key: string, now: number): void {
  const entry = passwordFailures.get(key);
  if (!entry || now >= entry.firstAt + PASSWORD_FAILURE_WINDOW_MS) {
    passwordFailures.set(key, { count: 1, firstAt: now });
  } else {
    entry.count += 1;
  }
}

/**
 * Validate a password change against the stored hash. Does not persist
 * anything - call applyPasswordChange() with the returned hash afterwards
 * so callers keep control over response handling.
 *
 * @param throttleKey rate-limit key (usually the client IP). Wrong
 *   current-password attempts count toward a 5-per-15-minutes lockout;
 *   omitting the key skips throttling (discouraged outside tests).
 */
export async function resolvePasswordChange(
  input: PasswordChangeInput,
  throttleKey?: string,
): Promise<PasswordChangeDecision> {
  const now = Date.now();
  if (throttleKey && isPasswordChangeThrottled(throttleKey, now)) {
    return {
      ok: false,
      error: 'Too many failed attempts. Try again in 15 minutes.',
      httpStatus: 429,
    };
  }

  const storedHash = getStringPref('auth.password_hash');
  if (!storedHash) {
    return { ok: false, error: 'Password not configured', httpStatus: 400 };
  }

  const currentOk = await verifyPassword(input.currentPassword, storedHash);
  if (!currentOk) {
    if (throttleKey) recordPasswordFailure(throttleKey, now);
    return { ok: false, error: 'Current password is incorrect', httpStatus: 401 };
  }
  if (throttleKey) passwordFailures.delete(throttleKey);

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
