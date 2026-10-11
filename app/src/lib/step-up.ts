import { verifyTOTP, checkRpcRateLimit, getClientAddress } from './auth';
import { getStringPref } from './prefs-db';

/**
 * Step-up authentication for money-movement endpoints (sends, bridge intent
 * signing, wallet restore). A stolen session cookie must not be enough to
 * move funds: these endpoints additionally require a fresh TOTP code, are
 * per-IP rate limited, and accept each code at most once per time window.
 */

export interface StepUpFailure {
  ok: false;
  status: number;
  error: string;
}

export type StepUpResult = { ok: true } | StepUpFailure;

// ── Shared TOTP verify + single-use burn ──────────────────────────────────────

const usedCodes = new Map<string, number>(); // `${code}@${period}` -> expiry ms

function pruneUsedCodes(now: number): void {
  for (const [key, expiry] of usedCodes) {
    if (now >= expiry) usedCodes.delete(key);
  }
}

export type TotpFailureReason = 'used' | 'invalid' | 'locked';

export type TotpCheck = { ok: true } | { ok: false; error: string; reason: TotpFailureReason };

/**
 * Canonical step-up error copy. The wording must state the remedy: a burned
 * code keeps failing for up to ~60s (the authenticator keeps showing the
 * burned code across the next rollover), so "invalid" alone reads like a
 * broken authenticator and pushes users into an unnecessary 2FA reset.
 */
export const TOTP_ERRORS = {
  used: 'Authenticator code already used. Wait up to a minute for a fresh code, then try again.',
  invalid: 'Invalid authenticator code.',
  locked: 'Too many failed authenticator-code attempts. Try again in 15 minutes.',
} as const;

// ── Failed-attempt throttle ──────────────────────────────────────────────────
// verifyAndBurnTotpCode accepts 3 of every 10^6 codes at any instant. Without
// throttling the direct callers (2FA reset, seed reveal, plugin install), a
// hijacked session can brute-force TOTP offline-speed and silently take over
// 2FA. Mirrors the login limiter: 5 failures per key per 15 minutes.

const MAX_TOTP_FAILURES = 5;
const TOTP_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const totpFailures = new Map<string, { count: number; firstAt: number }>();

function pruneTotpFailures(now: number): void {
  for (const [key, entry] of totpFailures) {
    if (now >= entry.firstAt + TOTP_FAILURE_WINDOW_MS) totpFailures.delete(key);
  }
}

export function isTotpThrottled(key: string, now: number = Date.now()): boolean {
  const entry = totpFailures.get(key);
  return !!entry && entry.count >= MAX_TOTP_FAILURES && now < entry.firstAt + TOTP_FAILURE_WINDOW_MS;
}

/**
 * Verify a TOTP code against `secret` and burn it (single use per window).
 * verifyTOTP accepts T-1..T+1, so the code is burned for the candidate
 * periods (~90s). Shared by the web step-up gate and the Telegram bot so a
 * code leaked via either channel cannot be replayed at the other.
 */
export function verifyAndBurnTotpCode(
  code: string,
  secret: string,
  throttleKey?: string,
): TotpCheck {
  const now = Date.now();
  pruneUsedCodes(now);
  pruneTotpFailures(now);
  if (throttleKey && isTotpThrottled(throttleKey, now)) {
    // Throttled: reject without verifying or burning, so a brute-force loop
    // cannot keep guessing and a legit retry cannot extend the lockout.
    return { ok: false, error: TOTP_ERRORS.locked, reason: 'locked' };
  }
  const period = Math.floor(now / 1000 / 30);
  const keys = [period - 1, period, period + 1].map((p) => `${code}@${p}`);
  if (keys.some((k) => usedCodes.has(k))) {
    return { ok: false, error: TOTP_ERRORS.used, reason: 'used' };
  }
  if (!verifyTOTP(code, secret)) {
    if (throttleKey) {
      const entry = totpFailures.get(throttleKey);
      if (!entry || now >= entry.firstAt + TOTP_FAILURE_WINDOW_MS) {
        totpFailures.set(throttleKey, { count: 1, firstAt: now });
      } else {
        entry.count += 1;
      }
    }
    return { ok: false, error: TOTP_ERRORS.invalid, reason: 'invalid' };
  }
  if (throttleKey) totpFailures.delete(throttleKey);
  const expiry = (period + 2) * 30 * 1000;
  for (const k of keys) usedCodes.set(k, expiry);
  return { ok: true };
}

/**
 * Enforce TOTP step-up for a sensitive operation.
 * @param totpCode 6-digit code from the client (empty string if not supplied)
 */
export function requireStepUp(
  totpCode: string,
  request: Request,
  clientAddress?: string,
): StepUpResult {
  const ip = getClientAddress(request, clientAddress);
  if (!checkRpcRateLimit(ip)) {
    return { ok: false, status: 429, error: 'Too many requests. Try again in a minute.' };
  }

  const secret = getStringPref('auth.totp_secret');
  if (!secret) {
    return { ok: false, status: 409, error: '2FA must be configured on this node' };
  }

  const code = typeof totpCode === 'string' ? totpCode.trim() : '';
  const check = verifyAndBurnTotpCode(code, secret, ip);
  if (!check.ok) {
    return { ok: false, status: 401, error: check.error };
  }

  return { ok: true };
}

/** Extract a TOTP code from a parsed JSON body (accepts both field spellings). */
export function totpFromBody(body: unknown): string {
  if (body == null || typeof body !== 'object') return '';
  const rec = body as Record<string, unknown>;
  for (const key of ['totp_code', 'totpCode']) {
    if (typeof rec[key] === 'string') return rec[key] as string;
  }
  return '';
}
