/**
 * auth.ts — Browser-level authentication utilities.
 *
 * All cryptographic operations use Node's built-in `crypto` module only —
 * no additional npm dependencies.
 *
 * Exports:
 *  - hashPassword / verifyPassword  — PBKDF2-SHA512
 *  - generateSessionToken / verifySessionToken  — HMAC-SHA256 signed cookie tokens
 *  - verifyTOTP  — RFC 6238 TOTP (Google Authenticator compatible)
 *  - checkLoginRateLimit / recordLoginFailure  — in-memory brute-force protection
 *  - checkRpcRateLimit  — in-memory API rate limiting
 *  - Cookie header helpers
 */

import crypto from 'node:crypto';

// ── Session constants ──────────────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = 'session';
const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_COOKIE_ATTRS = 'Path=/; HttpOnly; SameSite=Strict; Max-Age=1800';

export function makeSessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; ${SESSION_COOKIE_ATTRS}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

// ── Session secret guard ───────────────────────────────────────────────────────

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'SESSION_SECRET env var is missing or too short (min 32 chars). Run init.sh to configure authentication.',
    );
  }
  return secret;
}

// ── Password — PBKDF2-SHA512 ───────────────────────────────────────────────────
// Stored format: "pbkdf2:sha512:100000:<salt_hex>:<key_hex>"

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.randomBytes(32).toString('hex');
  const key = await pbkdf2(plain, salt, 100_000, 64, 'sha512');
  return `pbkdf2:sha512:100000:${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const [, digest, iterStr, salt, expectedHex] = parts;
  const iterations = parseInt(iterStr, 10);
  if (!digest || !salt || !expectedHex || isNaN(iterations)) return false;

  const key = await pbkdf2(plain, salt, iterations, expectedHex.length / 2, digest);
  const expected = Buffer.from(expectedHex, 'hex');
  if (key.length !== expected.length) return false;
  return crypto.timingSafeEqual(key, expected);
}

function pbkdf2(
  password: string,
  salt: string,
  iterations: number,
  keylen: number,
  digest: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, keylen, digest, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

// ── Session token — HMAC-SHA256 ────────────────────────────────────────────────
// Token format: "<timestamp_ms>.<hmac_sha256_hex>"

export function generateSessionToken(): string {
  const secret = getSessionSecret();
  const timestamp = Date.now().toString();
  const hmac = crypto.createHmac('sha256', secret).update(timestamp).digest('hex');
  return `${timestamp}.${hmac}`;
}

export function verifySessionToken(token: string): boolean {
  if (!token) return false;
  let secret: string;
  try {
    secret = getSessionSecret();
  } catch {
    return false;
  }

  const dotIdx = token.lastIndexOf('.');
  if (dotIdx === -1) return false;
  const timestamp = token.slice(0, dotIdx);
  const receivedHmac = token.slice(dotIdx + 1);

  // Check age
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Date.now() - ts > SESSION_MAX_AGE_MS) return false;

  // Timing-safe HMAC comparison
  const expectedHmac = crypto.createHmac('sha256', secret).update(timestamp).digest('hex');
  if (receivedHmac.length !== expectedHmac.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(receivedHmac, 'utf8'),
    Buffer.from(expectedHmac, 'utf8'),
  );
}

// ── TOTP — RFC 6238 ────────────────────────────────────────────────────────────

function decodeBase32(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const str = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of str) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue; // skip invalid chars gracefully
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function hotpCode(key: Buffer, counter: bigint): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    1_000_000;
  return code.toString().padStart(6, '0');
}

export function verifyTOTP(code: string, secret: string): boolean {
  if (!code || !secret || code.length !== 6 || !/^\d{6}$/.test(code)) return false;
  const key = decodeBase32(secret);
  const T = BigInt(Math.floor(Date.now() / 1000 / 30));

  // Check T-1, T, T+1 for clock skew tolerance
  for (const delta of [-1n, 0n, 1n]) {
    const candidate = hotpCode(key, T + delta);
    if (crypto.timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(code, 'utf8'))) {
      return true;
    }
  }
  return false;
}

// ── TOTP secret generation ─────────────────────────────────────────────────────

export function generateTotpSecret(): string {
  const bytes = crypto.randomBytes(20);
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '', bits = 0, value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      result += alpha[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += alpha[(value << (5 - bits)) & 31];
  return result;
}

// ── Login rate limiting ────────────────────────────────────────────────────────
// Max 5 failures per 15 minutes per IP

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

interface RateEntry {
  count: number;
  resetAt: number;
}

const loginAttempts = new Map<string, RateEntry>();

export function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now >= entry.resetAt) return true;
  return entry.count < LOGIN_MAX_ATTEMPTS;
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

// ── RPC rate limiting ──────────────────────────────────────────────────────────
// Max 120 requests per 60 seconds per IP

const RPC_MAX_REQUESTS = 120;
const RPC_WINDOW_MS = 60 * 1000;

const rpcAttempts = new Map<string, RateEntry>();

export function checkRpcRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rpcAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    rpcAttempts.set(ip, { count: 1, resetAt: now + RPC_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= RPC_MAX_REQUESTS;
}
