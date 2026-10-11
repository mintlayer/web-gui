/**
 * passkey.ts - WebAuthn / Passkeys server-side utilities.
 *
 * Uses @simplewebauthn/server (which relies on Node's built-in crypto).
 *
 * Exports:
 *  - StoredCredential type
 *  - getCredentials / saveCredentials - prefs-db persistence
 *  - createChallenge / consumeChallenge - in-memory challenge store
 *  - getRpId / getOrigin - env-var-with-request-fallback helpers
 *  - isValidRpId - rejects raw IP addresses
 *  - PASSKEY_CHALLENGE_COOKIE - cookie name for pending challenges
 */

import crypto from 'node:crypto';
import { getPref, setPref } from '@/lib/prefs-db';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface StoredCredential {
  id: string;        // base64url credential ID
  publicKey: string; // base64url COSE public key
  counter: number;   // signature counter (anti-replay)
  name: string;      // user-supplied label
  createdAt: number; // Unix ms
}

// ── Credential storage ─────────────────────────────────────────────────────────

export function getCredentials(): StoredCredential[] {
  return getPref<StoredCredential[]>('auth.passkeys') ?? [];
}

export function saveCredentials(creds: StoredCredential[]): void {
  setPref('auth.passkeys', creds);
}

// ── Challenge store ────────────────────────────────────────────────────────────
// In-memory, same pattern as login rate-limiter. Challenges expire after 5 min.

export const PASSKEY_CHALLENGE_COOKIE = 'pk_chal';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

type ChallengePurpose = 'registration' | 'authentication';

interface ChallengeEntry {
  challenge: string; // base64url
  expiresAt: number;
  purpose: ChallengePurpose;
}

const pendingChallenges = new Map<string, ChallengeEntry>();

export function createChallenge(challenge: string, purpose: ChallengePurpose): string {
  // Prune expired entries
  const now = Date.now();
  for (const [key, entry] of pendingChallenges) {
    if (now >= entry.expiresAt) pendingChallenges.delete(key);
  }

  const token = crypto.randomBytes(16).toString('hex');
  pendingChallenges.set(token, { challenge, expiresAt: now + CHALLENGE_TTL_MS, purpose });
  return token;
}

export function consumeChallenge(token: string, expectedPurpose: ChallengePurpose): string | null {
  const entry = pendingChallenges.get(token);
  if (!entry) return null;
  pendingChallenges.delete(token);
  if (Date.now() >= entry.expiresAt) return null;
  // A login challenge must never be redeemable as a registration challenge:
  // authentication challenges are minted on the public auth-options route
  // (no 2FA step-up), while registration challenges only exist behind a
  // burned TOTP code in register-options. Delete the entry either way.
  if (entry.purpose !== expectedPurpose) return null;
  return entry.challenge;
}

// ── RP ID / origin helpers ─────────────────────────────────────────────────────
// Prefer env vars (set by init.sh for reverse-proxy / DNS deployments);
// fall back to values derived from the incoming request URL.

/** True if the string looks like a raw IP (v4 or v6). localhost is allowed. */
export function isValidRpId(rpId: string): boolean {
  if (rpId === 'localhost') return true;
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rpId)) return false;
  // IPv6 (bracketed or bare) - require ':' or '[' so all-hex hostnames like
  // 'deadbeef' are not misclassified as IPv6 (Minor hardening)
  if (/[:\[]/.test(rpId) && /^[\[\]0-9a-fA-F:]+$/.test(rpId)) return false;
  return rpId.length > 0;
}

export function getRpId(requestUrl: string): string {
  if (process.env.PASSKEY_RP_ID) return process.env.PASSKEY_RP_ID;
  return new URL(requestUrl).hostname;
}

export function getOrigin(requestUrl: string): string {
  if (process.env.PASSKEY_ORIGIN) return process.env.PASSKEY_ORIGIN;
  return new URL(requestUrl).origin;
}

// ── Challenge cookie header helpers ───────────────────────────────────────────

export function makeChallengeCookieHeader(token: string): string {
  return `${PASSKEY_CHALLENGE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=300`;
}

export function clearChallengeCookieHeader(): string {
  return `${PASSKEY_CHALLENGE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`;
}

/**
 * Extract the challenge token from the request's challenge cookie and consume
 * it, expecting the given purpose. Returns the pending challenge, or null when
 * the cookie is missing/expired or the challenge was minted for another
 * purpose (e.g. an authentication challenge used for registration).
 */
export function consumeChallengeFromRequest(
  request: Request,
  expectedPurpose: ChallengePurpose,
): string | null {
  const cookieHeader = request.headers.get('cookie') ?? '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${PASSKEY_CHALLENGE_COOKIE}=([^;]+)`));
  const token = match?.[1] ?? '';
  return token ? consumeChallenge(token, expectedPurpose) : null;
}
